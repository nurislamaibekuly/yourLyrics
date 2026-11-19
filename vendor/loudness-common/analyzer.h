#pragma once
// Backdrop loudness analysis, shared by both capture helpers.
//
// A 2048-point Hann-windowed FFT every 512 frames (75 % overlap), 48
// log-spaced bands from 40 Hz up to the lesser of 16 kHz and Nyquist, each
// band averaged over its bins and mapped from a 66 dB window into 0..1, an
// instant attack with a ~0.43 s release (0.82 per ~86 ms block), and the
// low / mid / high / overall energies over those bands, weighted 0.5 / 0.35 /
// 0.15. Capture adapters only supply mono samples; the whole frequency-domain
// chain lives here once, so the macOS tap and the Windows loopback publish the
// same numbers.
//
// The previous chain (AGC, six absolute log bands, a 112.5 Hz leak/one-pole
// pipeline and a quintic smooth) is gone: its release was the reason a pause
// took seconds to fall, and its single 40 Hz band was the only thing the
// backdrop ever saw.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <vector>
#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#endif

namespace yourlyrics_loudness {

constexpr int kFftSize = 2048;
constexpr int kFftLog2 = 11;  // log2(kFftSize)
constexpr int kHopFrames = kFftSize / 4;
constexpr int kBandCount = 48;
constexpr int kMaxFftLog2 = 12;
constexpr int kMaxFftSize = 1 << kMaxFftLog2;

// Capture buffer size both adapters feed the analyzer (the macOS tap's IOProc
// buffer and the Windows reblock size). The analysis window is independent of
// it: it only sets how often a caller hands samples over.
constexpr int kAnalysisFrames = 1024;

constexpr float kPi = 3.14159265358979323846F;
constexpr float kBandLowHz = 40.0F;
constexpr float kBandTopHz = 16000.0F;
// The dB window each band is mapped through: (db + 66) / 66.
constexpr float kBandFloorDb = -66.0F;
constexpr float kBandRangeDb = 66.0F;
// Release: 0.82 per ~86 ms block, expressed here as a time constant so the same
// fall applies whatever cadence a caller publishes at.
constexpr float kReleaseSeconds = 0.43F;
// Band splits: the first 30 % of the log bands are "low", the next 33 % "mid".
constexpr int kLowPercent = 30;
constexpr int kMidPercent = 63;
// Low / mid / high weighting of the overall level.
constexpr float kOverallLow = 0.5F;
constexpr float kOverallMid = 0.35F;
constexpr float kOverallHigh = 0.15F;

struct LoudnessSample {
    float bands[kBandCount] = {};
    float low = 0.0F;
    float mid = 0.0F;
    float high = 0.0F;
    float overall = 0.0F;
    double rms = 0.0;
    double peak = 0.0;
    bool valid = false;
};

inline float clamp01(float v) {
    return v < 0.0F ? 0.0F : (v > 1.0F ? 1.0F : v);
}

inline int ilog2(int n) {
    int l = 0;
    while ((n >>= 1) != 0) {
        ++l;
    }
    return l;
}

#ifndef __APPLE__
// Portable radix-2 FFT for the Windows helper. Setup tables are built once per
// size on first use, so the audio path never allocates.
struct FftSetup {
    int log2n = 0;
    int n = 0;
    std::vector<int> bitrev;
    std::vector<float> cos;
    std::vector<float> sin;

    void build(int log2) {
        log2n = log2;
        n = 1 << log2;
        bitrev.resize(n);
        for (int i = 0; i < n; ++i) {
            int r = 0;
            for (int b = 0; b < log2; ++b) {
                if (i & (1 << b)) {
                    r |= 1 << (log2 - 1 - b);
                }
            }
            bitrev[i] = r;
        }
        cos.resize(n / 2);
        sin.resize(n / 2);
        const double tw = -2.0 * 3.14159265358979323846 / n;
        for (int k = 0; k < n / 2; ++k) {
            cos[k] = static_cast<float>(std::cos(tw * k));
            sin[k] = static_cast<float>(std::sin(tw * k));
        }
    }
};

FftSetup g_fftSetups[kMaxFftLog2 + 1];

inline void fftInPlace(int log2n, float* re, float* im) {
    FftSetup& s = g_fftSetups[log2n];
    if (s.n == 0) {
        s.build(log2n);
    }
    const int n = s.n;

    for (int i = 0; i < n; ++i) {
        const int r = s.bitrev[i];
        if (r > i) {
            std::swap(re[i], re[r]);
            std::swap(im[i], im[r]);
        }
    }

    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1;
        const int step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int j = 0; j < half; ++j) {
                const int t = j * step;
                const float wr = s.cos[t];
                const float wi = s.sin[t];
                const int a = i + j;
                const int b = a + half;
                const float xr = re[b] * wr - im[b] * wi;
                const float xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}
#endif

class SharedLoudnessAnalyzer {
public:
    explicit SharedLoudnessAnalyzer(const std::function<void(const LoudnessSample&)>& sink)
        : sink_(sink) {
        window_.resize(kFftSize);
        for (int i = 0; i < kFftSize; ++i) {
            window_[i] = 0.5F * (1.0F - std::cos(2.0F * kPi * static_cast<float>(i) /
                                                static_cast<float>(kFftSize - 1)));
        }
        ring_.assign(kFftSize, 0.0F);
        scratch_.assign(kFftSize, 0.0F);
        real_.assign(kFftSize, 0.0F);
        imag_.assign(kFftSize, 0.0F);
        magnitudes_.assign(kFftSize / 2, 0.0F);
        std::fill(std::begin(smoothed_), std::end(smoothed_), 0.0F);
        std::fill(std::begin(edges_), std::end(edges_), 1);
    }

#ifdef __APPLE__
    ~SharedLoudnessAnalyzer() {
        for (auto setup : fftSetup_) {
            if (setup) {
                vDSP_destroy_fftsetup(setup);
            }
        }
    }
#endif

    // Both adapters land here. Packet edges no longer matter: the ring buffer
    // is what makes the window, so a short WASAPI packet resolves 40 Hz exactly
    // as well as a long one.
    void ingestPackets(const float* frames, std::size_t count, double rate) {
        ingestMono(frames, count, rate);
    }

    void ingestMono(const float* frames, std::size_t count, double rate) {
        if (frames == nullptr || count == 0 || !(rate > 0.0)) {
            return;
        }
        ensureRate(rate);
        for (std::size_t i = 0; i < count; ++i) {
            ring_[ringHead_] = frames[i];
            ringHead_ = (ringHead_ + 1) % kFftSize;
            if (++sinceHop_ >= kHopFrames) {
                sinceHop_ = 0;
                analyse();
            }
        }
    }

private:
    std::function<void(const LoudnessSample&)> sink_;

    std::vector<float> window_;
    std::vector<float> ring_;
    std::vector<float> scratch_;
    std::vector<float> real_;
    std::vector<float> imag_;
    std::vector<float> magnitudes_;
    float smoothed_[kBandCount] = {};
    int edges_[kBandCount + 1] = {};
    int ringHead_ = 0;
    int sinceHop_ = 0;
    double rate_ = 0.0;
    float release_ = 0.0F;
#ifdef __APPLE__
    FFTSetup fftSetup_[kMaxFftLog2 + 1] = {};
    FFTSetup fftSetupForLog2(int log2n) {
        auto& setup = fftSetup_[log2n];
        if (!setup) {
            setup = vDSP_create_fftsetup(log2n, FFT_RADIX2);
        }
        return setup;
    }
#endif

    // Band edges and the release coefficient both follow the sample rate, and
    // `rate_ == 0` is the "nothing configured yet" state.
    void ensureRate(double rate) {
        if (rate_ > 0.0 && std::fabs(rate - rate_) < 1.0) {
            return;
        }
        rate_ = rate;
        release_ = std::exp(-static_cast<float>(kHopFrames) / static_cast<float>(rate_) /
                            kReleaseSeconds);
        const float top = std::min(kBandTopHz, static_cast<float>(rate_) * 0.5F);
        const float binHz = static_cast<float>(rate_) / static_cast<float>(kFftSize);
        for (int b = 0; b <= kBandCount; ++b) {
            const float edge = kBandLowHz * std::pow(
                top / kBandLowHz,
                static_cast<float>(b) / static_cast<float>(kBandCount));
            int bin = static_cast<int>(edge / binHz);
            edges_[b] = std::max(1, std::min(bin, kFftSize / 2 - 1));
        }
    }

    float averageBands(int from, int to) const {
        if (to <= from) {
            return 0.0F;
        }
        float sum = 0.0F;
        for (int b = from; b < to; ++b) {
            sum += smoothed_[b];
        }
        return sum / static_cast<float>(to - from);
    }

    void analyse() {
        // Oldest sample first, then the Hann window: window, FFT, per-band mean
        // power, 66 dB mapping.
        for (int i = 0; i < kFftSize; ++i) {
            scratch_[i] = ring_[(ringHead_ + i) % kFftSize] * window_[i];
        }

        double sumSquares = 0.0;
        double peak = 0.0;
        for (int i = 0; i < kFftSize; ++i) {
            const double v = scratch_[i];
            sumSquares += v * v;
            const double a = std::fabs(v);
            if (a > peak) {
                peak = a;
            }
        }

#ifdef __APPLE__
        DSPSplitComplex split{real_.data(), imag_.data()};
        vDSP_ctoz(reinterpret_cast<const DSPComplex*>(scratch_.data()), 2, &split, 1,
                  vDSP_Length(kFftSize / 2));
        vDSP_fft_zrip(fftSetupForLog2(kFftLog2), &split, 1, vDSP_Length(kFftLog2),
                      FFT_FORWARD);
        vDSP_zvmags(&split, 1, magnitudes_.data(), 1, vDSP_Length(kFftSize / 2));
#else
        std::copy(scratch_.begin(), scratch_.end(), real_.begin());
        std::fill(imag_.begin(), imag_.end(), 0.0F);
        fftInPlace(kFftLog2, real_.data(), imag_.data());
        // 4x the plain power spectrum so the packed-real magnitudes match what
        // vDSP_zvmags hands the macOS build; the same 4 / N^2 then normalises
        // both backends.
        for (int k = 0; k < kFftSize / 2; ++k) {
            magnitudes_[k] = 4.0F * (real_[k] * real_[k] + imag_[k] * imag_[k]);
        }
#endif

        const float norm = 4.0F / static_cast<float>(kFftSize * kFftSize);
        for (int b = 0; b < kBandCount; ++b) {
            const int lo = edges_[b];
            const int hi = std::max(lo + 1, edges_[b + 1]);
            float sum = 0.0F;
            for (int k = lo; k < hi; ++k) {
                sum += magnitudes_[k];
            }
            const float power = sum / static_cast<float>(hi - lo) * norm;
            const float db = 10.0F * std::log10(std::max(power, 1e-12F));
            const float raw = clamp01((db - kBandFloorDb) / kBandRangeDb);
            // Instant attack, exponential release: a kick lands on the block it
            // arrives in and a pause falls at kReleaseSeconds, as the reference.
            smoothed_[b] = raw > smoothed_[b]
                               ? raw
                               : smoothed_[b] * release_ + raw * (1.0F - release_);
        }

        const int lowEnd = std::max(1, kBandCount * kLowPercent / 100);
        const int midEnd = std::max(2, kBandCount * kMidPercent / 100);

        LoudnessSample sample;
        sample.valid = true;
        for (int b = 0; b < kBandCount; ++b) {
            sample.bands[b] = smoothed_[b];
        }
        sample.low = averageBands(0, lowEnd);
        sample.mid = averageBands(lowEnd, midEnd);
        sample.high = averageBands(midEnd, kBandCount);
        sample.overall = sample.low * kOverallLow + sample.mid * kOverallMid +
                         sample.high * kOverallHigh;
        sample.rms = std::sqrt(sumSquares / kFftSize);
        sample.peak = peak;

        if (sink_) {
            sink_(sample);
        }
    }
};
}  // namespace yourlyrics_loudness
