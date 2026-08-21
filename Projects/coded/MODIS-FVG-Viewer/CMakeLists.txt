cmake_minimum_required(VERSION 3.15)
project(MODIS-FVG-Viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# The GUI application is Windows-only (Win32 + GDI+ + WinHTTP + Media
# Foundation + DWM). The decoding/compositing core (modis/image/colormap) is
# portable and is exercised by the tests + tools on any platform, so `ctest`
# runs the correctness checks even off-Windows.
# ---------------------------------------------------------------------------
if(WIN32)
    add_executable(MODIS-FVG-Viewer WIN32
        src/app.cpp
        src/modis.cpp
        src/image.cpp
        src/gibs.cpp
        src/mf_encoder.cpp
        src/app.rc
    )
    target_link_libraries(MODIS-FVG-Viewer PRIVATE
        gdiplus comctl32 comdlg32 dwmapi
        winhttp shlwapi
        mfplat mfreadwrite mfuuid
        ole32 uuid gdi32 user32 shell32
    )

    if(MINGW)
        # -municode so wWinMain is found; static runtimes make the exe portable.
        target_link_options(MODIS-FVG-Viewer PRIVATE
            -municode -mwindows -static -static-libgcc -static-libstdc++)
    endif()
    if(MSVC)
        # We embed our own manifest via app.rc; stop the linker adding a second.
        target_link_options(MODIS-FVG-Viewer PRIVATE /MANIFEST:NO)
    endif()

    # Copy the bundled sample granules next to the built exe for a ready-to-run
    # demo (the viewer seeds its sequence from these on first launch).
    foreach(s sample_MODIS_FVG.mgr sample_MODIS_FVG_1200.mgr sample_MODIS_FVG_1345.mgr)
        add_custom_command(TARGET MODIS-FVG-Viewer POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${CMAKE_SOURCE_DIR}/test/${s} $<TARGET_FILE_DIR:MODIS-FVG-Viewer>/${s})
    endforeach()
endif()

# ---------------------------------------------------------------------------
# Portable tests (run via CTest — no Windows required).
# ---------------------------------------------------------------------------
enable_testing()

add_executable(test_modis test/test_modis.cpp src/modis.cpp)
add_test(NAME reader COMMAND test_modis ${CMAKE_SOURCE_DIR}/test/sample_MODIS_FVG.mgr)

add_executable(test_image test/test_image.cpp src/modis.cpp src/image.cpp)
add_test(NAME compositing COMMAND test_image ${CMAKE_SOURCE_DIR}/test/sample_MODIS_FVG.mgr)

# ---------------------------------------------------------------------------
# Portable developer tools: regenerate the sample granule / the README preview.
# ---------------------------------------------------------------------------
add_executable(make_sample tools/make_sample.cpp)
add_executable(preview_render tools/preview_render.cpp src/modis.cpp src/image.cpp)
