// loudness-tap (Windows): system-audio loopback that publishes the same JSON
// lines on stdout as the macOS CoreAudio process-tap helper, so the Node
// parent (src/main/loudness.js) needs no platform-specific parsing:
//
//     {"type":"ready","target":"loopback"}
//     {"type":"status","state":"capturing","pid":1234}
//     {"type":"status","state":"idle"}
//     {"type":"status","state":"error","detail":"...","code":-1}
//     {"type":"sample","low":0.62,"mid":0.48,"high":0.21,"overall":0.55,"rms":0.456,"peak":0.789}
//
// Capture is WASAPI shared-mode loopback of the default render endpoint: it
// hears every app that plays through the default output. The analysis chain
// is shared with the macOS helper in loudness-common/analyzer.h; only the
// FFT backend differs (portable radix-2 complex
// instead of vDSP, with powers scaled 4x to match vDSP's packed real-FFT
// convention so the absolute log-band sums land on the same numbers).
//
// The renderer sees the low/mid/high energies plus their 0.5/0.35/0.15 overall.

// NOMINMAX: windows.h defines min/max macros that break every std::min/
// std::max call below; the code only wants the std:: versions.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS  // getenv
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <vector>

// --- stdout protocol -------------------------------------------------------

static void emitLine(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vprintf(format, args);
    va_end(args);
    fputc('\n', stdout);
}

#include "../loudness-common/analyzer.h"
using namespace yourlyrics_loudness;
using LoudnessAnalyzer = SharedLoudnessAnalyzer;

// --- WASAPI loopback capture -----------------------------------------------

namespace {

// HRESULT -> stable short string for the error status line.
const char* hresultName(HRESULT hr) {
    switch (static_cast<unsigned long>(hr)) {
        case static_cast<unsigned long>(0x88890001): return "notimplemented";
        case static_cast<unsigned long>(0x88890004): return "invalidargument";
        case static_cast<unsigned long>(0x88890008): return "outofmemory";
        case static_cast<unsigned long>(0x8889001C): return "nointerface";
        case static_cast<unsigned long>(0x8889001D): return "pointer";
        case static_cast<unsigned long>(0x88890026): return "wrongformat";
        case static_cast<unsigned long>(0x88890028): return "bufferoverflow";
        case static_cast<unsigned long>(0x88890033): return "unsupportedformat";
        case static_cast<unsigned long>(0x88890040): return "deviceinvalidated";
        case static_cast<unsigned long>(0x8889004A): return "nomixdevice";
        case static_cast<unsigned long>(0x80070490): return "nodevice";  // E_DEVICE_NOT_FOUND
        default: return "hresult";
    }
}

void emitSetupFailure(const char* detail, HRESULT hr) {
    std::fflush(stdout);
    emitLine("{\"type\":\"status\",\"state\":\"error\",\"detail\":\"%s\",\"code\":%ld}",
             detail, static_cast<long>(hr));
}

// Shared-mode loopback of the default render endpoint. The capture thread is
// the whole program: get buffer -> mono downmix -> analyzer -> publish.
class LoopbackCapture {
public:
    // Returns S_OK and runs until stop is set or the device dies; on setup
    // failure emits the error status line and returns the failing hr.
    HRESULT run(volatile bool* stop) {
        HRESULT hr = S_OK;
        IMMDeviceEnumerator* enumerator = nullptr;
        IMMDevice* device = nullptr;
        IAudioClient* client = nullptr;
        IAudioCaptureClient* capture = nullptr;
        WAVEFORMATEX* mix = nullptr;

        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(&enumerator));
        if (FAILED(hr)) {
            emitSetupFailure("enumerator_create_failed", hr);
            return hr;
        }

        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
        if (FAILED(hr)) {
            emitSetupFailure("default_device_failed", hr);
            enumerator->Release();
            return hr;
        }

        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(&client));
        if (FAILED(hr)) {
            emitSetupFailure("activate_failed", hr);
            device->Release();
            enumerator->Release();
            return hr;
        }

        hr = client->GetMixFormat(&mix);
        if (FAILED(hr) || mix == nullptr) {
            emitSetupFailure("mix_format_failed", hr);
            client->Release();
            device->Release();
            enumerator->Release();
            return hr;
        }

        // 100 ms shared-mode loopback: the standard shared engine period is
        // fine; loopback mirrors whatever the engine renders.
        const REFERENCE_TIME bufferDuration = 1000000;  // 100 ms in 100ns
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                bufferDuration, 0, mix, nullptr);
        if (FAILED(hr)) {
            emitSetupFailure("initialize_failed", hr);
            CoTaskMemFree(mix);
            client->Release();
            device->Release();
            enumerator->Release();
            return hr;
        }

        hr = client->GetService(__uuidof(IAudioCaptureClient),
                                reinterpret_cast<void**>(&capture));
        if (FAILED(hr)) {
            emitSetupFailure("capture_service_failed", hr);
            CoTaskMemFree(mix);
            client->Release();
            device->Release();
            enumerator->Release();
            return hr;
        }

        const double rate = static_cast<double>(mix->nSamplesPerSec);
        const int channels = static_cast<int>(mix->nChannels);
        // Float detection without ksmedia.h: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT is
        // {0x00000003-0000-0010-8000-00aa00389b71}; compared field-wise so no
        // SDK import library is needed.
        static const GUID kSubtypeFloat = {
            0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
        const bool isFloat =
            mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
            (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
             reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix)->SubFormat == kSubtypeFloat);
        const int bytesPerSample = static_cast<int>(mix->wBitsPerSample / 8);
        const bool isInterleaved = true;  // shared-mode mix formats are interleaved

        std::vector<float> mono;
        mono.reserve(kMaxFftSize);
        LoudnessAnalyzer analyzer([](const LoudnessSample& sample) {
            if (!sample.valid) {
                return;
            }
            emitLine("{\"type\":\"sample\",\"low\":%.5f,\"mid\":%.5f,\"high\":%.5f,"
                     "\"overall\":%.5f,\"rms\":%.5f,\"peak\":%.5f}",
                     sample.low, sample.mid, sample.high, sample.overall, sample.rms,
                     sample.peak);
        });

        hr = client->Start();
        if (FAILED(hr)) {
            emitSetupFailure("start_failed", hr);
            capture->Release();
            CoTaskMemFree(mix);
            client->Release();
            device->Release();
            enumerator->Release();
            return hr;
        }

        emitLine("{\"type\":\"status\",\"state\":\"capturing\",\"pid\":%ld}",
                 static_cast<long>(GetCurrentProcessId()));

        // Poll every ~10 ms: drain every packet the engine has delivered,
        // downmix to mono, feed the analyzer in <= kMaxFftSize chunks.
        while (!*stop) {
            UINT32 packet = 0;
            hr = capture->GetNextPacketSize(&packet);
            if (FAILED(hr)) {
                break;  // device invalidated; the parent restarts us
            }
            while (packet > 0 && !*stop) {
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;
                hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
                if (FAILED(hr)) {
                    break;
                }
                if (frames > 0) {
                    mono.clear();
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        mono.assign(frames, 0.0F);
                    } else if (isInterleaved) {
                        const int frameBytes = channels * bytesPerSample;
                        for (UINT32 i = 0; i < frames; ++i) {
                            const BYTE* frame = data + i * frameBytes;
                            float acc = 0.0F;
                            for (int ch = 0; ch < channels; ++ch) {
                                if (isFloat) {
                                    acc += reinterpret_cast<const float*>(frame)[ch];
                                } else {
                                    acc += static_cast<float>(
                                               reinterpret_cast<const std::int16_t*>(
                                                   frame)[ch]) /
                                           32768.0F;
                                }
                            }
                            mono.push_back(acc / static_cast<float>(channels));
                        }
                    }
                    // Analyze in FFT-sized chunks; the analyzer's metronome
                    // sets the publish cadence, not this loop.
                    std::size_t offset = 0;
                    while (offset < mono.size()) {
                        const std::size_t n =
                            std::min(mono.size() - offset,
                                     static_cast<std::size_t>(kMaxFftSize));
                        analyzer.ingestPackets(mono.data() + offset, n, rate);
                        offset += n;
                    }
                }
                capture->ReleaseBuffer(frames);
                hr = capture->GetNextPacketSize(&packet);
                if (FAILED(hr)) {
                    break;
                }
            }
            Sleep(10);
        }

        client->Stop();
        capture->Release();
        CoTaskMemFree(mix);
        client->Release();
        device->Release();
        enumerator->Release();
        return S_OK;
    }
};

volatile bool g_stop = false;

BOOL WINAPI consoleHandler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT ||
        type == CTRL_CLOSE_EVENT) {
        g_stop = true;
        return TRUE;
    }
    return FALSE;
}

}  // namespace

int main(int argc, const char* argv[]) {
    (void)argc;
    (void)argv;

    // The Windows CRT treats _IOLBF as full buffering. Deliver each sample
    // immediately instead of batching it behind the parent's freshness limit.
    setvbuf(stdout, nullptr, _IONBF, 0);

    emitLine("{\"type\":\"ready\",\"target\":\"loopback\"}");

    SetConsoleCtrlHandler(consoleHandler, TRUE);

    const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        emitSetupFailure("com_init_failed", hr);
        return 1;
    }

    LoopbackCapture capture;
    const HRESULT runHr = capture.run(&g_stop);

    CoUninitialize();

    if (g_stop) {
        return 0;  // orderly teardown
    }
    if (FAILED(runHr)) {
        return 1;  // setup or device failure; the parent logs and retries
    }
    return 0;
}
