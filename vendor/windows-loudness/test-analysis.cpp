// Native regression check: g++ -std=c++17 -O2 -static test-analysis.cpp
// -o build/test-analysis.exe -lole32 -luuid
#define main loudnessHelperMain
#include "main.cpp"
#undef main
#include <stdexcept>

static void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    LoudnessSample directSample, packetSample;
    int publications = 0;
    LoudnessAnalyzer direct([&](const LoudnessSample& s) { directSample = s; });
    LoudnessAnalyzer packets([&](const LoudnessSample& s) {
        packetSample = s;
        ++publications;
    });
    float window[1024];
    for (int block = 0; block < 24; ++block) {
        for (int i = 0; i < 1024; ++i) {
            window[i] = 0.2F * std::sin(2.0 * 3.141592653589793 * 80.0 *
                                       (block * 1024 + i) / 48000.0);
        }
        Sleep(22);
        direct.ingestMono(window, 1024, 48000);
        packets.ingestPackets(window, 480, 48000);
        if (block == 0) check(publications == 0, "Analyzed a partial WASAPI packet");
        packets.ingestPackets(window + 480, 480, 48000);
        packets.ingestPackets(window + 960, 64, 48000);
        check(packetSample.valid, "Did not analyze a complete 1024-frame window");
        check(std::fabs(directSample.rms - packetSample.rms) < 1e-6,
              "Packet boundaries changed AGC/RMS");
        check(std::fabs(directSample.peak - packetSample.peak) < 1e-6,
              "Packet boundaries changed peak level");
    }
    check(packetSample.low > 0.05F, "Bass signal produced no response");
    const float activeLow = packetSample.low;
    std::fill_n(window, 1024, 0.0F);
    for (int block = 0; block < 60; ++block) {
        Sleep(22);
        packets.ingestPackets(window, 1024, 48000);
    }
    check(packetSample.rms == 0.0, "Silence retained old audio samples");
    // 60 blocks of 22 ms is 1.32 s, about three release constants, so the low
    // band has to be under a tenth of where it started.
    check(packetSample.low < activeLow * 0.1F,
          "Bass failed to decay with the release setting");
    std::puts("PASS: 1024-frame analysis, packet-independent bands, bass response, silence release");
}
