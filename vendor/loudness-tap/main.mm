// Loudness for the yourLyrics Electron backdrop, from one target app's output.
//
// A standalone helper: given a bundle id, it taps that process's audio with a
// CoreAudio process tap (macOS 14.2+), runs the reference's analysis over every
// delivered buffer, and prints one JSON object per line on stdout. The Electron
// main process owns the child, so nothing here knows about Electron, and the
// renderer only ever sees the band the backdrop pulses from.
//
// The capture mechanism and the analysis are a port of the native app's
// src/audio/MusicLoudnessProvider.mm, which recovered both from the reference
// binary. What changed is the target: the native app taps Apple Music by
// bundle-id constant, this helper taps whatever bundle id it is handed, because
// the Electron app follows whichever player is now-playing.
//
//     loudness-tap <bundle-id>
//
// stdout protocol, one JSON object per line:
//
//     {"type":"ready","target":"com.apple.Music"}
//     {"type":"status","state":"capturing","pid":1234}
//     {"type":"status","state":"idle"}
//     {"type":"status","state":"error","detail":"...","code":-10851}
//     {"type":"sample","band":0.123,"rms":0.456,"peak":0.789}
//
// A line is emitted on every state change, and a sample line on every analysis
// hop (512 frames, 75 % overlap). Silence and a dead target simply stop
// producing samples; the parent treats a gap past its freshness window as
// zero, which is the same thing the native monitor does.
//
// The tap needs the audio-capture permission (NSAudioCaptureUsageDescription in
// the host app's Info.plist) and no Screen Recording permission. Electron ships
// that key already; the packaged app declares it through electron-builder.

#import <Accelerate/Accelerate.h>
#import <AppKit/AppKit.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdarg>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <mutex>
#include <vector>
#include <memory>
#include <string>
#include "../loudness-common/analyzer.h"
#ifdef LOUDNESS_TAP_ADDON
#define NAPI_VERSION 8
#include <node_api.h>
#endif
using namespace yourlyrics_loudness;

namespace {

// --- stdout / callback protocol -------------------------------------------

std::mutex gEmitMutex;
std::function<void(const char*)> gEmitSink;

void emitLine(const char* format, ...) __attribute__((format(printf, 1, 2)));

void emitLine(const char* format, ...) {
    char buffer[1024];
    va_list args;
    va_start(args, format);
    const int written = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    if (written <= 0) {
        return;
    }
    std::lock_guard<std::mutex> lock(gEmitMutex);
    if (gEmitSink) {
        gEmitSink(buffer);
    } else {
        puts(buffer);
    }
}

// --- capture plumbing (identical roles to the native port) ----------------

// How often the target's pid is re-resolved. The tap is per-process, so a
// player relaunch (new pid) needs a teardown plus a fresh setup, and a quit
// needs a teardown; polling the pid is the whole re-tap mechanism.
// How often a player relaunch behind a fixed bundle id is rediscovered. 0.5 s
// rather than the reference's 2 s: the poll is a NSRunningApplication lookup
// (the tap itself is set up exactly once per pid), and two seconds of deafness
// after a relaunch is a fifth of the delay the user can see.
constexpr double kTapPidPollSeconds = 0.5;

// IOProc buffer size in frames. The analysis windows each delivered buffer's
// own tail with nextPow2(delivered), so this only sets the callback cadence
// (~21 ms at 48 kHz), not the measurement.
constexpr UInt32 kTapBufferFrames = kAnalysisFrames;

// Mono sample ring between the HAL realtime thread and the drain queue.
// 65536 frames is ~1.4 s at 48 kHz, so a stalled drain drops oldest-first
// rather than growing latency without bound.
constexpr std::uint32_t kTapRingCapacity = 1 << 16;
constexpr std::uint32_t kTapRingMask = kTapRingCapacity - 1;

} // namespace
@interface LoudnessAnalyzer : NSObject
- (instancetype)initWithSink:(const std::function<void(const LoudnessSample&)>&)sink;
- (void)ingestMono:(const float*)frames count:(std::size_t)count sampleRate:(double)rate;
@end
@implementation LoudnessAnalyzer {
    std::unique_ptr<SharedLoudnessAnalyzer> _core;
}
- (instancetype)initWithSink:(const std::function<void(const LoudnessSample&)>&)sink {
    self = [super init];
    if (self) _core = std::make_unique<SharedLoudnessAnalyzer>(sink);
    return self;
}
- (void)ingestMono:(const float*)frames count:(std::size_t)count sampleRate:(double)rate {
    _core->ingestMono(frames, count, rate);
}
@end

// The capture: a CoreAudio process tap on the target's pid, wrapped in a
// private aggregate device and read through an IOProc.
@interface TapCapture : NSObject
@end

static OSStatus TapIOProc(
    AudioObjectID device,
    const AudioTimeStamp* now,
    const AudioBufferList* input,
    const AudioTimeStamp* inputTime,
    AudioBufferList* output,
    const AudioTimeStamp* outputTime,
    void* clientData);

@implementation TapCapture {
    std::function<void(const LoudnessSample&)> _sink;
    LoudnessAnalyzer* _analyzer;

    // Everything below is touched only on this queue, except the ring indices
    // and _drainPending, which the HAL thread also touches, and _running,
    // which the IOProc reads.
    dispatch_queue_t _queue;
    dispatch_source_t _retryTimer;

    NSString* _bundleId;
    NSString* _lastState;

    AudioObjectID _tapID;
    AudioObjectID _aggID;
    AudioDeviceIOProcID _procID;
    pid_t _tappedPid;
    double _sampleRate;
    UInt32 _channels;
    bool _tapIsFloat;
    bool _tapInterleaved;
    UInt32 _tapBytesPerSample;

    // Mono float ring between the HAL realtime thread (writer) and the drain
    // (reader). Indices are monotonic; the slot is index & mask. Overflow drops
    // oldest-first so a stalled drain cannot grow latency without bound.
    std::vector<float> _ring;
    std::atomic<std::uint32_t> _ringWrite;
    std::atomic<std::uint32_t> _ringRead;
    std::atomic<bool> _drainPending;
    std::vector<float> _scratch;
    std::atomic<bool> _running;

    // Lifetime lock between the HAL realtime thread and teardown. The IOProc
    // takes it with try_lock (never waits: a contended buffer is dropped, not
    // queued behind destruction), teardown takes it blocking, and the IOProc
    // re-checks _running once inside. That ordering is the whole guarantee:
    // teardown cannot free the ring while an invocation is inside it, and an
    // invocation that arrives during or after teardown finds _running false
    // and touches nothing.
    std::mutex _lifetimeMutex;

    bool _wasRunning;
}

- (instancetype)init {
    self = [super init];
    if (self != nil) {
        _queue = dispatch_queue_create("yl.loudness.tap", DISPATCH_QUEUE_SERIAL);
        _tapID = kAudioObjectUnknown;
        _aggID = kAudioObjectUnknown;
        _procID = nullptr;
        _tappedPid = -1;
        _sampleRate = 0.0;
        _channels = 0;
        _bundleId = nil;
        _lastState = nil;
        _ring.assign(kTapRingCapacity, 0.0F);
        _ringWrite.store(0, std::memory_order_relaxed);
        _ringRead.store(0, std::memory_order_relaxed);
        _drainPending.store(false, std::memory_order_relaxed);
        _scratch.assign(kMaxFftSize, 0.0F);
        _running.store(false, std::memory_order_relaxed);
        _wasRunning = false;
    }
    return self;
}

- (void)startWithTarget:(NSString*)bundleId
                   sink:(const std::function<void(const LoudnessSample&)>&)sink {
    _sink = sink;
    _bundleId = [bundleId copy];
    _analyzer = [[LoudnessAnalyzer alloc] initWithSink:sink];
    __weak TapCapture* weakSelf = self;
    dispatch_async(_queue, ^{
        @autoreleasepool {
            TapCapture* strongSelf = weakSelf;
            if (strongSelf == nil) {
                return;
            }
            [strongSelf tick];
            [strongSelf armRetryTimer];
        }
    });
}

// Synchronous, and that is load-bearing rather than cautious: an async teardown
// frees the capture while the IOProc is still registered, and the next realtime
// callback then runs on freed memory. dispatch_sync cannot deadlock here --
// stop() runs on the parent thread, never on _queue, and nothing on _queue
// waits on the parent.
- (void)stop {
    dispatch_sync(_queue, ^{
        @autoreleasepool {
            [self disarmRetryTimer];
            [self teardown];
            _analyzer = nil;
        }
    });
}

// The whole re-tap mechanism: the tap is per-process, so a target relaunch (new
// pid) needs a fresh setup and a quit needs a teardown. Polling the pid is all
// of it.
- (void)tick {
    if (!@available(macOS 14.2, *)) {
        [self emitState:@"error"];
        return;
    }
    const pid_t pid = [TapCapture pidForBundleId:_bundleId];
    if (pid <= 0) {
        if (_wasRunning) {
            [self teardown];
        }
        [self emitState:@"idle"];
        return;
    }
    if (_wasRunning && pid == _tappedPid) {
        [self emitState:@"capturing"];
        return;
    }
    [self teardown];
    if ([self startTapForPid:pid]) {
        [self emitState:@"capturing"];
    }
}

- (void)emitState:(NSString*)state {
    if (_lastState != nil && [_lastState isEqualToString:state]) {
        return;
    }
    _lastState = [state copy];
    if ([state isEqualToString:@"capturing"]) {
        emitLine("{\"type\":\"status\",\"state\":\"capturing\",\"pid\":%d}",
                 static_cast<int>(_tappedPid));
    } else if ([state isEqualToString:@"idle"]) {
        emitLine("{\"type\":\"status\",\"state\":\"idle\"}");
    } else {
        emitLine("{\"type\":\"status\",\"state\":\"error\",\"detail\":\"unsupported_os\"}");
    }
}

- (void)armRetryTimer {
    if (_retryTimer != nullptr) {
        return;
    }
    __weak TapCapture* weakSelf = self;
    _retryTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _queue);
    dispatch_source_set_event_handler(_retryTimer, ^{
        @autoreleasepool {
            TapCapture* strongSelf = weakSelf;
            if (strongSelf != nil) {
                [strongSelf tick];
            }
        }
    });
    dispatch_source_set_timer(
        _retryTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTapPidPollSeconds * NSEC_PER_SEC)),
        (uint64_t)(kTapPidPollSeconds * NSEC_PER_SEC),
        (uint64_t)(0.5 * NSEC_PER_SEC));
    dispatch_resume(_retryTimer);
}

- (void)disarmRetryTimer {
    if (_retryTimer != nullptr) {
        dispatch_source_cancel(_retryTimer);
        _retryTimer = nullptr;
    }
}

+ (pid_t)pidForBundleId:(NSString*)bundleId {
    if (bundleId.length == 0) {
        return -1;
    }
    NSArray<NSRunningApplication*>* apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
    for (NSRunningApplication* app in apps) {
        const pid_t pid = app.processIdentifier;
        if (pid > 0) {
            return pid;
        }
    }
    return -1;
}

// The setup, in the reference's own order: pid -> process object -> tap
// description -> tap -> tap format -> aggregate -> nominal rate -> IOProc ->
// buffer size -> start. Every failure unwinds what it built.
- (bool)startTapForPid:(pid_t)pid {
    const AudioObjectPropertyAddress pidAddress = {
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    AudioObjectID processObject = kAudioObjectUnknown;
    UInt32 size = sizeof(processObject);
    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &pidAddress, sizeof(pid), &pid, &size, &processObject);
    if (status != noErr || processObject == kAudioObjectUnknown) {
        [self emitSetupFailure:@"pid_lookup_failed" code:status];
        return false;
    }

    // Stereo mixdown of that one process. The mix is a copy: the player keeps
    // playing audibly -- muting the tap would silence the user, which is never
    // what a level meter wants.
    CATapDescription* tapDesc = [[CATapDescription alloc]
        initStereoMixdownOfProcesses:@[ @(processObject) ]];
    if (tapDesc == nil) {
        [self emitSetupFailure:@"tap_description_nil" code:noErr];
        return false;
    }
    tapDesc.name = @"yourLyricsLoudnessTap";
    tapDesc.muteBehavior = CATapUnmuted;
    tapDesc.exclusive = NO;
    tapDesc.privateTap = YES;

    AudioObjectID tapID = kAudioObjectUnknown;
    status = AudioHardwareCreateProcessTap(tapDesc, &tapID);
    if (status != noErr || tapID == kAudioObjectUnknown) {
        // A denial lands here: the audio-capture permission is missing or was
        // refused, and the parent reports it as an error state.
        [self emitSetupFailure:@"create_process_tap_failed" code:status];
        return false;
    }

    AudioStreamBasicDescription tapFormat = {};
    const AudioObjectPropertyAddress formatAddress = {
        kAudioTapPropertyFormat,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    size = sizeof(tapFormat);
    status = AudioObjectGetPropertyData(
        tapID, &formatAddress, 0, nullptr, &size, &tapFormat);
    if (status != noErr || tapFormat.mSampleRate <= 0.0 || tapFormat.mChannelsPerFrame == 0) {
        [self emitSetupFailure:@"tap_format_unreadable" code:status];
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }
    const bool isFloat =
        (tapFormat.mFormatID == kAudioFormatLinearPCM) &&
        ((tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0);
    const bool interleaved = (tapFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0;
    const UInt32 bytesPerSample = tapFormat.mBitsPerChannel / 8;
    if ((!isFloat && bytesPerSample != 2) || (isFloat && bytesPerSample != 4)) {
        [self emitSetupFailure:@"unsupported_sample_width" code:noErr];
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    // The aggregate device wraps the tap so it reads as an ordinary input: a
    // tap read directly as a device rejects everything.
    NSString* tapUUID = tapDesc.UUID.UUIDString;
    NSDictionary* tapEntry = @{
        (NSString*)CFSTR(kAudioSubTapUIDKey) : tapUUID,
        (NSString*)CFSTR(kAudioSubTapDriftCompensationKey) : @YES,
    };
    // Per-process UID. A fixed one is the reference's choice and is fine while
    // exactly one instance exists, but CoreAudio refuses a second aggregate with
    // the same UID outright ('nope'), which turns any instance that outlived its
    // parent -- a crash, a stray from an interrupted run -- into a permanent
    // "capture is broken" for every attempt after it. A private device nobody
    // else can name is worth naming uniquely.
    NSString* aggUID = [NSString stringWithFormat:@"com.yourlyrics.loudness.AggDevice.%d",
                        (int)getpid()];
    NSDictionary* aggDesc = @{
        (NSString*)CFSTR(kAudioAggregateDeviceNameKey) : @"yourLyricsAggDevice",
        (NSString*)CFSTR(kAudioAggregateDeviceUIDKey) : aggUID,
        (NSString*)CFSTR(kAudioAggregateDeviceTapListKey) : @[ tapEntry ],
        (NSString*)CFSTR(kAudioAggregateDeviceTapAutoStartKey) : @YES,
        (NSString*)CFSTR(kAudioAggregateDeviceIsPrivateKey) : @YES,
    };
    AudioObjectID aggID = kAudioObjectUnknown;
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggDesc, &aggID);
    if (status != noErr || aggID == kAudioObjectUnknown) {
        [self emitSetupFailure:@"create_aggregate_device_failed" code:status];
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    const double rate = tapFormat.mSampleRate;
    const AudioObjectPropertyAddress rateAddress = {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    status = AudioObjectSetPropertyData(aggID, &rateAddress, 0, nullptr, sizeof(rate), &rate);
    if (status != noErr) {
        [self emitSetupFailure:@"nominal_rate_rejected" code:status];
        AudioHardwareDestroyAggregateDevice(aggID);
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    AudioDeviceIOProcID procID = nullptr;
    status = AudioDeviceCreateIOProcID(aggID, TapIOProc, (__bridge void*)self, &procID);
    if (status != noErr || procID == nullptr) {
        [self emitSetupFailure:@"create_ioproc_failed" code:status];
        AudioHardwareDestroyAggregateDevice(aggID);
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    const UInt32 bufferFrames = kTapBufferFrames;
    const AudioObjectPropertyAddress framesAddress = {
        kAudioDevicePropertyBufferFrameSize,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    status = AudioObjectSetPropertyData(
        aggID, &framesAddress, 0, nullptr, sizeof(bufferFrames), &bufferFrames);
    if (status != noErr) {
        [self emitSetupFailure:@"buffer_size_rejected" code:status];
        AudioDeviceDestroyIOProcID(aggID, procID);
        AudioHardwareDestroyAggregateDevice(aggID);
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    status = AudioDeviceStart(aggID, procID);
    if (status != noErr) {
        [self emitSetupFailure:@"device_start_failed" code:status];
        AudioDeviceDestroyIOProcID(aggID, procID);
        AudioHardwareDestroyAggregateDevice(aggID);
        AudioHardwareDestroyProcessTap(tapID);
        return false;
    }

    _tapID = tapID;
    _aggID = aggID;
    _procID = procID;
    _tappedPid = pid;
    _sampleRate = rate;
    _channels = tapFormat.mChannelsPerFrame;
    _tapIsFloat = isFloat;
    _tapInterleaved = interleaved;
    _tapBytesPerSample = bytesPerSample;
    _wasRunning = true;
    _running.store(true, std::memory_order_release);
    return true;
}

- (void)emitSetupFailure:(NSString*)detail code:(OSStatus)code {
    // Emitted straight through rather than via emitState: failures are
    // actionable and idiosyncratic, and the parent logs them verbatim. The
    // details are fixed literals, so there is no quoting to do beyond handing
    // %s the ASCII view.
    emitLine("{\"type\":\"status\",\"state\":\"error\",\"detail\":\"%s\",\"code\":%d}",
             detail.UTF8String, static_cast<int>(code));
}

- (void)teardown {
    _running.store(false, std::memory_order_release);
    // Held across the HAL destruction: any IOProc already inside its critical
    // section finishes first (bounded memcpy, microseconds), and any that
    // arrives later fails try_lock or sees _running false.
    const std::lock_guard<std::mutex> lock(_lifetimeMutex);
    if (_procID != nullptr && _aggID != kAudioObjectUnknown) {
        (void)AudioDeviceStop(_aggID, _procID);
        (void)AudioDeviceDestroyIOProcID(_aggID, _procID);
        _procID = nullptr;
    }
    if (_aggID != kAudioObjectUnknown) {
        (void)AudioHardwareDestroyAggregateDevice(_aggID);
        _aggID = kAudioObjectUnknown;
    }
    if (_tapID != kAudioObjectUnknown) {
        (void)AudioHardwareDestroyProcessTap(_tapID);
        _tapID = kAudioObjectUnknown;
    }
    _tappedPid = -1;
    _wasRunning = false;
    _lastState = nil;
}

// IOProc body, kept out of the C callback so the realtime thread does one
// message send and a bounded memcpy and nothing else: no blocking lock (the
// ring is lock-free; the mutex below is try-only), no allocation (the drain is
// coalesced through an atomic flag), no logging.
- (void)handleTapInput:(const AudioBufferList*)input {
    if (!_lifetimeMutex.try_lock()) {
        return;
    }
    const std::lock_guard<std::mutex> guard(_lifetimeMutex, std::adopt_lock);
    if (!_running.load(std::memory_order_acquire)) {
        return;
    }
    if (input == nullptr || input->mNumberBuffers == 0) {
        return;
    }
    const UInt32 channels = _channels;
    if (channels == 0) {
        return;
    }
    const UInt32 bytesPerFrame = _tapBytesPerSample * (_tapInterleaved ? channels : 1);
    if (bytesPerFrame == 0) {
        return;
    }
    const UInt32 frames =
        static_cast<UInt32>(input->mBuffers[0].mDataByteSize / bytesPerFrame);
    if (frames == 0 || frames > kTapRingCapacity) {
        return;
    }
    const bool isFloat = _tapIsFloat;
    const bool interleaved = _tapInterleaved;

    std::uint32_t w = _ringWrite.load(std::memory_order_relaxed);
    const std::uint32_t r = _ringRead.load(std::memory_order_acquire);
    if (w - r + frames > kTapRingCapacity) {
        // Full: drop oldest-first. A stalled drain then costs content, not
        // latency, which is the right trade for a meter.
        _ringRead.store(w + frames - kTapRingCapacity, std::memory_order_release);
    }
    float* const ring = _ring.data();
    for (UInt32 i = 0; i < frames; ++i) {
        float acc = 0.0F;
        if (interleaved) {
            const void* const base = input->mBuffers[0].mData;
            if (isFloat) {
                const float* const s = static_cast<const float*>(base) + i * channels;
                for (UInt32 ch = 0; ch < channels; ++ch) {
                    acc += s[ch];
                }
            } else {
                const std::int16_t* const s =
                    static_cast<const std::int16_t*>(base) + i * channels;
                for (UInt32 ch = 0; ch < channels; ++ch) {
                    acc += static_cast<float>(s[ch]) / 32768.0F;
                }
            }
        } else {
            for (UInt32 ch = 0; ch < channels; ++ch) {
                if (ch >= input->mNumberBuffers) {
                    break;
                }
                const void* const base = input->mBuffers[ch].mData;
                if (base == nullptr) {
                    continue;
                }
                if (isFloat) {
                    acc += static_cast<const float*>(base)[i];
                } else {
                    acc += static_cast<float>(static_cast<const std::int16_t*>(base)[i]) /
                           32768.0F;
                }
            }
        }
        ring[(w + i) & kTapRingMask] = acc / static_cast<float>(channels);
    }
    _ringWrite.store(w + frames, std::memory_order_release);

    bool expected = false;
    if (_drainPending.compare_exchange_strong(expected, true)) {
        __weak TapCapture* weakSelf = self;
        dispatch_async(_queue, ^{
            @autoreleasepool {
                TapCapture* strongSelf = weakSelf;
                if (strongSelf == nil) {
                    return;
                }
                strongSelf->_drainPending.store(false, std::memory_order_relaxed);
                [strongSelf drain];
            }
        });
    }
}

// Serial-queue drain: move whatever the tap delivered into the analyzer in
// analysis-sized chunks. The analyzer's own metronome, not this loop, sets the
// publish cadence.
- (void)drain {
    for (;;) {
        const std::uint32_t w = _ringWrite.load(std::memory_order_acquire);
        std::uint32_t r = _ringRead.load(std::memory_order_relaxed);
        const std::uint32_t available = w - r;
        if (available == 0) {
            return;
        }
        const std::uint32_t n = std::min(available, static_cast<std::uint32_t>(kMaxFftSize));
        const float* const ring = _ring.data();
        float* const scratch = _scratch.data();
        for (std::uint32_t i = 0; i < n; ++i) {
            scratch[i] = ring[(r + i) & kTapRingMask];
        }
        _ringRead.store(r + n, std::memory_order_release);
        [_analyzer ingestMono:scratch count:n sampleRate:_sampleRate];
    }
}

@end

// The HAL realtime entry point. One message send; the running check and the
// lifetime lock both live inside handleTapInput:.
static OSStatus TapIOProc(
    AudioObjectID device,
    const AudioTimeStamp* now,
    const AudioBufferList* input,
    const AudioTimeStamp* inputTime,
    AudioBufferList* output,
    const AudioTimeStamp* outputTime,
    void* clientData) {
    (void)device;
    (void)now;
    (void)inputTime;
    (void)output;
    (void)outputTime;
    TapCapture* const capture = (__bridge TapCapture*)clientData;
    [capture handleTapInput:input];
    return noErr;
}

#ifdef LOUDNESS_TAP_ADDON

namespace {

TapCapture* gActiveCapture = nil;
napi_threadsafe_function gTsfn = nullptr;

void callJsLine(napi_env env, napi_value jsCallback, void* context, void* data) {
    (void)context;
    std::unique_ptr<std::string> line(static_cast<std::string*>(data));
    if (env == nullptr || jsCallback == nullptr || !line) {
        return;
    }
    napi_value undefined;
    napi_value arg;
    if (napi_get_undefined(env, &undefined) != napi_ok ||
        napi_create_string_utf8(env, line->c_str(), line->size(), &arg) != napi_ok) {
        return;
    }
    napi_call_function(env, undefined, jsCallback, 1, &arg, nullptr);
}

void stopAddon(void* arg = nullptr) {
    (void)arg;
    TapCapture* capture = gActiveCapture;
    gActiveCapture = nil;
    if (capture != nil) {
        [capture stop];
    }
    napi_threadsafe_function tsfn = nullptr;
    {
        std::lock_guard<std::mutex> lock(gEmitMutex);
        gEmitSink = nullptr;
        tsfn = gTsfn;
        gTsfn = nullptr;
    }
    if (tsfn != nullptr) {
        napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    }
}

napi_value addonStart(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
        napi_throw_type_error(env, nullptr, "start(bundleId, callback) requires 2 arguments");
        return nullptr;
    }

    size_t targetLen = 0;
    if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &targetLen) != napi_ok ||
        targetLen == 0) {
        napi_throw_type_error(env, nullptr, "bundleId must be a non-empty string");
        return nullptr;
    }
    std::string targetStr(targetLen, '\0');
    napi_get_value_string_utf8(env, argv[0], targetStr.data(), targetLen + 1, &targetLen);

    napi_valuetype cbType = napi_undefined;
    if (napi_typeof(env, argv[1], &cbType) != napi_ok || cbType != napi_function) {
        napi_throw_type_error(env, nullptr, "callback must be a function");
        return nullptr;
    }

    stopAddon();

    napi_value asyncName;
    napi_create_string_utf8(env, "yourLyricsLoudnessTap", NAPI_AUTO_LENGTH, &asyncName);
    napi_threadsafe_function tsfn = nullptr;
    if (napi_create_threadsafe_function(
            env, argv[1], nullptr, asyncName, 0, 1, nullptr, nullptr, nullptr,
            callJsLine, &tsfn) != napi_ok || tsfn == nullptr) {
        napi_throw_error(env, nullptr, "failed to create threadsafe function");
        return nullptr;
    }

    {
        std::lock_guard<std::mutex> lock(gEmitMutex);
        gTsfn = tsfn;
        gEmitSink = [tsfn](const char* line) {
            if (line == nullptr) {
                return;
            }
            auto* payload = new std::string(line);
            if (napi_call_threadsafe_function(tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
                delete payload;
            }
        };
    }

    @autoreleasepool {
        NSString* target = [NSString stringWithUTF8String:targetStr.c_str()];
        emitLine("{\"type\":\"ready\",\"target\":\"%s\"}", targetStr.c_str());

        TapCapture* capture = [[TapCapture alloc] init];
        gActiveCapture = capture;
        [capture startWithTarget:target sink:[](const LoudnessSample& sample) {
            if (!sample.valid) {
                return;
            }
            emitLine("{\"type\":\"sample\",\"low\":%.5f,\"mid\":%.5f,\"high\":%.5f,"
                     "\"overall\":%.5f,\"rms\":%.5f,\"peak\":%.5f}",
                     sample.low, sample.mid, sample.high, sample.overall, sample.rms,
                     sample.peak);
        }];
    }

    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
}

napi_value addonStop(napi_env env, napi_callback_info info) {
    (void)info;
    stopAddon();
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
}

napi_value initAddon(napi_env env, napi_value exports) {
    napi_add_env_cleanup_hook(env, stopAddon, nullptr);
    napi_property_descriptor props[] = {
        {"start", nullptr, addonStart, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, addonStop, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initAddon)

#else

int main(int argc, const char* argv[]) {
    @autoreleasepool {
        if (argc < 2 || argv[1] == nullptr || argv[1][0] == '\0') {
            fprintf(stderr, "usage: %s <bundle-id>\n", argv[0]);
            return 2;
        }

        // Line buffered so the parent never sits on a partial sample line: the
        // freshness window above is only meaningful if lines arrive when they
        // are produced.
        setvbuf(stdout, nullptr, _IOLBF, 0);

        NSString* target = [NSString stringWithUTF8String:argv[1]];
        emitLine("{\"type\":\"ready\",\"target\":\"%s\"}", argv[1]);

        TapCapture* capture = [[TapCapture alloc] init];
        [capture startWithTarget:target sink:[](const LoudnessSample& sample) {
            if (!sample.valid) {
                return;
            }
            emitLine("{\"type\":\"sample\",\"low\":%.5f,\"mid\":%.5f,\"high\":%.5f,"
                     "\"overall\":%.5f,\"rms\":%.5f,\"peak\":%.5f}",
                     sample.low, sample.mid, sample.high, sample.overall, sample.rms,
                     sample.peak);
        }];

        // Orderly teardown on quit: the aggregate device and the tap are ours
        // to destroy, and leaving them alive after the process is gone is how a
        // dead pid keeps a device slot. Signals are delivered on the main queue
        // as dispatch sources so the teardown can run real code.
        dispatch_source_t signals[2];
        const int caught[2] = {SIGTERM, SIGINT};
        for (int i = 0; i < 2; ++i) {
            signal(caught[i], SIG_IGN);
            signals[i] = dispatch_source_create(
                DISPATCH_SOURCE_TYPE_SIGNAL, caught[i], 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(signals[i], ^{
                [capture stop];
                exit(0);
            });
            dispatch_resume(signals[i]);
        }

        dispatch_main();
    }
    return 0;
}

#endif
