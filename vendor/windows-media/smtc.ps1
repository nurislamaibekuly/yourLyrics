param(
  [ValidateSet('info', 'seek')]
  [string]$Action = 'info',
  [double]$Position = 0,
  [switch]$Serve
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

# WinRT APIs are asynchronous. PowerShell can await the IAsyncOperation<T>
# objects exposed by Windows after converting them to .NET tasks.
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.IsGenericMethod -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1)

if ($null -eq $script:asTaskGeneric) {
  throw 'Could not find the WinRT IAsyncOperation adapter.'
}

function Await($operation, [Type]$resultType, [int]$timeoutMs = 8000) {
  $task = $script:asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) {
    throw 'The Windows media API timed out.'
  }
  if ($task.IsFaulted) {
    $inner = $task.Exception
    while ($null -ne $inner.InnerException) {
      $inner = $inner.InnerException
    }
    throw $inner.Message
  }
  return $task.Result
}

$script:managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$script:propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$script:streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$script:readerType = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$script:manager = $null
$script:emptyCount = 0
$script:lastSource = ''
$script:lastThumbKey = ''
$script:lastThumbData = $null
$script:lastThumbSentKey = ''
$script:lastThumbAttempt = [DateTime]::MinValue

function Get-Manager {
  if ($null -ne $script:manager) {
    return $script:manager
  }

  $managerType = $script:managerType
  try {
    $script:manager = Await ($managerType::RequestAsync()) ($managerType)
  } catch {
    $script:manager = $null
    throw
  }
  return $script:manager
}

function Get-AppLabel([string]$source) {
  if ($source -match 'AppleMusic|AppleInc') { return 'Apple Music' }
  if ($source -match 'Spotify') { return 'Spotify' }
  if ($source -match 'ZuneMusic|ZuneVideo|MediaPlayer') { return 'Media Player' }
  if ([string]::IsNullOrWhiteSpace($source)) { return 'Media' }
  return $source
}

function Get-SessionInfo($session) {
  if ($null -eq $session) {
    return $null
  }

  $props = Await ($session.TryGetMediaPropertiesAsync()) ($script:propsType)
  if ($null -eq $props) {
    return $null
  }

  $playback = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()
  $status = [string]$playback.PlaybackStatus
  $source = [string]$session.SourceAppUserModelId
  $title = [string]$props.Title
  $artist = [string]$props.Artist
  $album = [string]$props.AlbumTitle

  if ($source -match 'Spotify' -and
      [string]::IsNullOrWhiteSpace($artist) -and
      $title -match '^(.+?)\s+-\s+(.+)$') {
    $artist = $matches[1].Trim()
    $title = $matches[2].Trim()
  }

  $start = $timeline.StartTime
  $durationSeconds = ($timeline.EndTime - $start).TotalSeconds
  $positionSeconds = ($timeline.Position - $start).TotalSeconds
  if ([double]::IsNaN($durationSeconds) -or $durationSeconds -lt 0) {
    $durationSeconds = 0
  }
  if ([double]::IsNaN($positionSeconds) -or $positionSeconds -lt 0) {
    $positionSeconds = 0
  }

  $rate = 1.0
  $playbackRate = $playback.PlaybackRate
  if ($null -ne $playbackRate) {
    $candidate = [double]$playbackRate
    if ($candidate -gt 0 -and $candidate -le 16) {
      $rate = $candidate
    }
  }

  # Some players only publish a timeline when playback state changes. Project
  # the reported position forward while the track is playing so the UI and
  # lyric clock do not freeze between SMTC updates.
  if ($status -eq 'Playing' -and $durationSeconds -gt 0) {
    $elapsedMs = ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalMilliseconds
    if ($elapsedMs -gt 0 -and $elapsedMs -lt 86400000) {
      $positionSeconds += ($elapsedMs / 1000.0) * $rate
    }
    $positionSeconds = [Math]::Min($positionSeconds, $durationSeconds)
  }

  return [pscustomobject]@{
    session = $session
    source = $source
    app = Get-AppLabel $source
    title = $title
    artist = $artist
    album = $album
    playbackStatus = $status
    playing = ($status -eq 'Playing')
    position = $positionSeconds
    duration = $durationSeconds
    thumbnailRef = $props.Thumbnail
  }
}

function Select-Session($manager) {
  $current = $null
  try {
    $current = $manager.GetCurrentSession()
  } catch {
    $current = $null
  }

  $sessions = @($manager.GetSessions() | Where-Object { $null -ne $_ })
  if ($sessions.Count -eq 0) {
    $script:emptyCount += 1
    if ($script:emptyCount -ge 4) {
      $script:emptyCount = 0
      $script:manager = $null
    }
    if ($null -ne $current) {
      try {
        $info = Get-SessionInfo $current
        if ($null -ne $info) {
          return [pscustomobject]@{ session = $current; info = $info }
        }
      } catch {
        return $null
      }
    }
    return $null
  }
  $script:emptyCount = 0

  $currentSource = if ($null -ne $current) { [string]$current.SourceAppUserModelId } else { '' }
  $best = $null
  $bestScore = -100000

  foreach ($session in $sessions) {
    try {
      $info = Get-SessionInfo $session
    } catch {
      continue
    }
    if ($null -eq $info) {
      continue
    }

    $score = 0
    if ($info.playing) { $score += 1000 }
    elseif ($info.playbackStatus -eq 'Paused') { $score += 200 }
    if (-not [string]::IsNullOrWhiteSpace($info.title)) { $score += 100 }
    if ($info.source -match 'AppleMusic|AppleInc') { $score += 30 }
    if ($info.source -eq $script:lastSource) { $score += 20 }
    if ($info.source -eq $currentSource) { $score += 10 }
    if ($info.source -match 'ShellExperienceHost|System|Windows') { $score -= 500 }
    if ($info.title -match 'Microsoft|Windows|Operating System') { $score -= 500 }

    if ($score -gt $bestScore) {
      $bestScore = $score
      $best = [pscustomobject]@{ session = $session; info = $info }
    }
  }

  if ($null -ne $best) {
    return $best
  }
  if ($null -ne $current) {
    try {
      return [pscustomobject]@{
        session = $current
        info = Get-SessionInfo $current
      }
    } catch {
      return $null
    }
  }
  return $null
}

function Read-Thumbnail($info) {
  if ($null -eq $info -or $null -eq $info.thumbnailRef) {
    return $null
  }

  $stream = $null
  $inputStream = $null
  $reader = $null
  try {
    $stream = Await ($info.thumbnailRef.OpenReadAsync()) ($script:streamType)
    if ($null -eq $stream -or $stream.Size -le 0 -or $stream.Size -gt 5242880) {
      return $null
    }

    $inputStream = $stream.GetInputStreamAt(0)
    $readerType = $script:readerType
    $reader = $readerType::new($inputStream)
    [void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
    $bytes = New-Object byte[] ([int]$stream.Size)
    $reader.ReadBytes($bytes)

    $contentType = [string]$stream.ContentType
    $firstType = if ($contentType) { ([string]$contentType).Split(',')[0].Trim() } else { '' }
    if ($firstType -notmatch '^image/[A-Za-z0-9][A-Za-z0-9.+-]*$') {
      $firstType = 'image/jpeg'
    }
    return 'data:' + $firstType + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch {
    return $null
  } finally {
    if ($null -ne $reader) { try { $reader.Dispose() } catch { } }
    if ($null -ne $inputStream) { try { $inputStream.Dispose() } catch { } }
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
  }
}

function Get-InfoPayload {
  $manager = Get-Manager
  $selection = Select-Session $manager

  if ($null -eq $selection -or $null -eq $selection.info) {
    return @{
      ok = $true
      active = $false
      app = ''
      source = ''
      title = ''
      artist = ''
      album = ''
      playbackStatus = 'Closed'
      playing = $false
      position = 0
      duration = 0
      thumbnail = $null
    }
  }

  $info = $selection.info
  if ([string]::IsNullOrWhiteSpace($info.title)) {
    return @{
      ok = $true
      active = $false
      app = $info.app
      source = $info.source
      title = ''
      artist = $info.artist
      album = $info.album
      playbackStatus = $info.playbackStatus
      playing = $false
      position = 0
      duration = 0
      thumbnail = $null
    }
  }

  $script:lastSource = $info.source
  $key = @($info.source, $info.title, $info.artist, $info.album) -join '|'
  if ($key -ne $script:lastThumbKey) {
    $script:lastThumbKey = $key
    $script:lastThumbData = $null
    $script:lastThumbSentKey = ''
    # A new browser track must not inherit the previous track's retry delay.
    $script:lastThumbAttempt = [DateTime]::MinValue
  }

  if ($null -eq $script:lastThumbData -and
      ([DateTime]::UtcNow - $script:lastThumbAttempt).TotalSeconds -ge 2) {
    $script:lastThumbAttempt = [DateTime]::UtcNow
    $thumbnail = Read-Thumbnail $info
    if ($null -ne $thumbnail) {
      $script:lastThumbData = $thumbnail
    }
  }

  $thumbnailOut = $null
  if ($null -ne $script:lastThumbData -and $key -ne $script:lastThumbSentKey) {
    $thumbnailOut = $script:lastThumbData
    $script:lastThumbSentKey = $key
  }

  return @{
    ok = $true
    active = $true
    app = $info.app
    source = $info.source
    title = $info.title
    artist = $info.artist
    album = $info.album
    playbackStatus = $info.playbackStatus
    playing = $info.playing
    position = [Math]::Round($info.position, 3)
    duration = [Math]::Round($info.duration, 3)
    thumbnail = $thumbnailOut
  }
}

function Invoke-Seek([double]$seconds) {
  if ([double]::IsNaN($seconds) -or [double]::IsInfinity($seconds) -or $seconds -lt 0) {
    return @{ ok = $false; action = 'seek'; error = 'bad_position' }
  }

  $manager = Get-Manager
  $sessions = @($manager.GetSessions() | Where-Object { $null -ne $_ })
  $session = $null
  if (-not [string]::IsNullOrWhiteSpace($script:lastSource)) {
    $session = $sessions |
      Where-Object { [string]$_.SourceAppUserModelId -eq $script:lastSource } |
      Select-Object -First 1
  }
  if ($null -eq $session) {
    $session = $manager.GetCurrentSession()
  }
  if ($null -eq $session) {
    return @{ ok = $false; action = 'seek'; error = 'no_session' }
  }

  $playback = $session.GetPlaybackInfo()
  if ($null -eq $playback.Controls -or -not $playback.Controls.IsPlaybackPositionEnabled) {
    return @{ ok = $false; action = 'seek'; error = 'not_seekable' }
  }

  $timeline = $session.GetTimelineProperties()
  [long]$startTicks = $timeline.StartTime.Ticks
  [long]$minTicks = $timeline.MinSeekTime.Ticks
  [long]$maxTicks = $timeline.MaxSeekTime.Ticks
  if ($maxTicks -le $minTicks) {
    $minTicks = $startTicks
    $maxTicks = [long]$timeline.EndTime.Ticks
  }
  if ($maxTicks -le $minTicks) {
    return @{ ok = $false; action = 'seek'; error = 'not_seekable' }
  }

  [long]$targetTicks = $startTicks + [long][Math]::Round($seconds * [TimeSpan]::TicksPerSecond)
  if ($targetTicks -lt $minTicks) { $targetTicks = $minTicks }
  if ($targetTicks -gt $maxTicks) { $targetTicks = $maxTicks }

  $ok = Await ($session.TryChangePlaybackPositionAsync($targetTicks)) ([bool])
  return @{
    ok = [bool]$ok
    action = 'seek'
    error = $(if ($ok) { '' } else { 'seek_failed' })
    position = $seconds
  }
}

function Invoke-Playback([string]$command) {
  if (@('play', 'pause', 'previous', 'next') -cnotcontains $command) {
    return @{ ok = $false; action = $command; error = 'invalid_action' }
  }

  # Match seek's targeting: the displayed source first, then the current session.
  $manager = Get-Manager
  $sessions = @($manager.GetSessions() | Where-Object { $null -ne $_ })
  $session = $null
  if (-not [string]::IsNullOrWhiteSpace($script:lastSource)) {
    $session = $sessions |
      Where-Object { [string]$_.SourceAppUserModelId -eq $script:lastSource } |
      Select-Object -First 1
  }
  if ($null -eq $session) {
    $session = $manager.GetCurrentSession()
  }
  if ($null -eq $session) {
    return @{ ok = $false; action = $command; error = 'no_session' }
  }

  $ok = switch -CaseSensitive ($command) {
    'play' { Await ($session.TryPlayAsync()) ([bool]) }
    'pause' { Await ($session.TryPauseAsync()) ([bool]) }
    'previous' { Await ($session.TrySkipPreviousAsync()) ([bool]) }
    'next' { Await ($session.TrySkipNextAsync()) ([bool]) }
  }
  return @{
    ok = [bool]$ok
    action = $command
    error = $(if ($ok) { '' } else { 'playback_failed' })
  }
}

function Write-Frame($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine('SMTC ' + $json)
  [Console]::Out.Flush()
}

if (-not $Serve) {
  try {
    $payload = Get-InfoPayload
    $payload.action = 'info'
    Write-Frame $payload
  } catch {
    Write-Frame @{ ok = $false; action = 'info'; error = $_.Exception.Message }
  }
  exit 0
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) {
    break
  }
  $line = $line.Trim()
  if ($line -eq '') {
    continue
  }

  $id = $null
  $requestAction = 'info'
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $requestAction = [string]$request.action
    if ($requestAction -eq 'seek') {
      $payload = Invoke-Seek ([double]$request.position)
    } elseif (@('play', 'pause', 'previous', 'next') -ccontains $requestAction) {
      $payload = Invoke-Playback $requestAction
    } elseif ($requestAction -eq 'info') {
      $payload = Get-InfoPayload
      $payload.action = 'info'
    } else {
      $payload = @{ ok = $false; action = $requestAction; error = 'invalid_action' }
    }
    $payload.id = $id
    Write-Frame $payload
  } catch {
    Write-Frame @{
      id = $id
      ok = $false
      action = $requestAction
      error = $_.Exception.Message
    }
  }
}
