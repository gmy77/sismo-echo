// Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
// MODIS-FVG Viewer 1.0.0 - vedi LICENSE nella radice del repository.
// mf_encoder.h — H.264/MP4 timelapse encoding via Media Foundation (native
// Windows, no ffmpeg). Windows-only; the portable modules never include this.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace mf {

// Encode a sequence of top-down 32-bit ARGB frames (each exactly w*h pixels,
// pixel = 0xAARRGGBB) to an H.264 MP4 at `fps` frames/second.
// Returns false and fills *err on failure. w and h should be even.
bool encodeH264(const std::wstring& outPath, int w, int h, int fps,
                const std::vector<std::vector<uint32_t>>& frames,
                std::wstring* err = nullptr);

} // namespace mf
