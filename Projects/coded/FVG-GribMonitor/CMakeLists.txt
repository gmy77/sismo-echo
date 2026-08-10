cmake_minimum_required(VERSION 3.15)
project(FVG-GribMonitor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# GUI subsystem application (no console window).
add_executable(FVG-GribMonitor WIN32
    src/app.cpp
    src/grib2.cpp
    src/net.cpp
    src/app.rc
)

target_link_libraries(FVG-GribMonitor PRIVATE
    gdiplus comctl32 comdlg32 winhttp shell32 gdi32 user32 ole32
)

if(MINGW)
    # MinGW needs -municode so wWinMain is picked up, and static runtimes make
    # the exe portable (no MinGW DLLs required on the target machine).
    target_link_options(FVG-GribMonitor PRIVATE -municode -static -static-libgcc -static-libstdc++)
endif()

# Copy the sample GRIB and config next to the built exe for a ready-to-run app.
add_custom_command(TARGET FVG-GribMonitor POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/config.ini $<TARGET_FILE_DIR:FVG-GribMonitor>/config.ini
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/test/sample_FVG_CAPE.grib2 $<TARGET_FILE_DIR:FVG-GribMonitor>/sample_FVG_CAPE.grib2
)
