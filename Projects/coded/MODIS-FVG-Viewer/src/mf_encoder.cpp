// mf_encoder.cpp — Media Foundation Sink Writer H.264 encoder.
// Follows the canonical MSDN "Using the Sink Writer to Encode Video" pattern.
#include "mf_encoder.h"

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <wrl/client.h>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")

using Microsoft::WRL::ComPtr;

namespace mf {

static bool fail(std::wstring* err, const wchar_t* m, HRESULT hr = S_OK) {
    if (err) {
        wchar_t buf[256];
        if (hr != S_OK) swprintf(buf, 256, L"%s (hr=0x%08lX)", m, (unsigned long)hr);
        else            swprintf(buf, 256, L"%s", m);
        *err = buf;
    }
    return false;
}

bool encodeH264(const std::wstring& outPath, int w, int h, int fps,
                const std::vector<std::vector<uint32_t>>& frames,
                std::wstring* err) {
    if (frames.empty())          return fail(err, L"nessun fotogramma da codificare");
    if (w <= 1 || h <= 1)        return fail(err, L"dimensioni video non valide");
    if (fps < 1)  fps = 1;
    if (fps > 60) fps = 60;
    // H.264 wants even dimensions.
    w &= ~1; h &= ~1;

    const UINT32 bitrate = (UINT32)((double)w * h * fps * 0.12) + 2'000'000u;

    HRESULT hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) return fail(err, L"MFStartup fallita", hr);

    struct MFGuard { ~MFGuard() { MFShutdown(); } } mfGuard;

    ComPtr<IMFSinkWriter> writer;
    hr = MFCreateSinkWriterFromURL(outPath.c_str(), nullptr, nullptr, &writer);
    if (FAILED(hr)) return fail(err, L"creazione SinkWriter fallita", hr);

    // Output media type: H.264.
    ComPtr<IMFMediaType> outType;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    outType->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
    outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(outType.Get(), MF_MT_FRAME_SIZE, w, h);
    MFSetAttributeRatio(outType.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(outType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

    DWORD streamIndex = 0;
    hr = writer->AddStream(outType.Get(), &streamIndex);
    if (FAILED(hr)) return fail(err, L"AddStream fallita", hr);

    // Input media type: uncompressed RGB32 (MF inserts the colour converter).
    ComPtr<IMFMediaType> inType;
    MFCreateMediaType(&inType);
    inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    inType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    inType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(inType.Get(), MF_MT_FRAME_SIZE, w, h);
    MFSetAttributeRatio(inType.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(inType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

    hr = writer->SetInputMediaType(streamIndex, inType.Get(), nullptr);
    if (FAILED(hr)) return fail(err, L"SetInputMediaType fallita", hr);

    hr = writer->BeginWriting();
    if (FAILED(hr)) return fail(err, L"BeginWriting fallita", hr);

    const LONG   stride     = (LONG)w * 4;                 // top-down RGB32
    const DWORD  frameBytes = (DWORD)stride * h;
    const LONGLONG frameDur = 10'000'000LL / fps;          // 100-ns units
    LONGLONG      ts        = 0;

    for (const auto& fr : frames) {
        if ((int)fr.size() < w * h) return fail(err, L"fotogramma troppo piccolo");

        ComPtr<IMFMediaBuffer> buffer;
        hr = MFCreateMemoryBuffer(frameBytes, &buffer);
        if (FAILED(hr)) return fail(err, L"MFCreateMemoryBuffer fallita", hr);

        BYTE* dst = nullptr;
        hr = buffer->Lock(&dst, nullptr, nullptr);
        if (FAILED(hr)) return fail(err, L"Lock buffer fallita", hr);

        // Copy the ARGB frame top-down into the RGB32 buffer.
        hr = MFCopyImage(dst, stride,
                         reinterpret_cast<const BYTE*>(fr.data()), stride,
                         (DWORD)w * 4, h);
        buffer->Unlock();
        if (FAILED(hr)) return fail(err, L"MFCopyImage fallita", hr);

        buffer->SetCurrentLength(frameBytes);

        ComPtr<IMFSample> sample;
        hr = MFCreateSample(&sample);
        if (FAILED(hr)) return fail(err, L"MFCreateSample fallita", hr);
        sample->AddBuffer(buffer.Get());
        sample->SetSampleTime(ts);
        sample->SetSampleDuration(frameDur);
        ts += frameDur;

        hr = writer->WriteSample(streamIndex, sample.Get());
        if (FAILED(hr)) return fail(err, L"WriteSample fallita", hr);
    }

    hr = writer->Finalize();
    if (FAILED(hr)) return fail(err, L"Finalize fallita", hr);
    return true;
}

} // namespace mf
