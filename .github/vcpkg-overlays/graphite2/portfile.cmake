vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO silnrsi/graphite
    REF 92f59dcc52f73ce747f1cdc831579ed2546884aa # 1.3.14
    SHA512 011855576124b2f9ae9d7d3a0dfc5489794cf82b81bebc02c11c9cca350feb9fbb411844558811dff1ebbacac58a24a7cf56a374fc2c27e97a5fb4795a01486e
    HEAD_REF master
    PATCHES disable-tests.patch
)

# Fix symbol visibility for static builds:
# 1. Remove -fvisibility=hidden from COMPILE_FLAGS (target property overrides CMAKE_*_FLAGS)
# 2. Add GRAPHITE2_EXPORTING so GR2_API = visibility("default") even in static builds
file(READ "${SOURCE_PATH}/src/CMakeLists.txt" _src_cmake)
string(REPLACE "-fvisibility=hidden" "" _src_cmake "${_src_cmake}")
string(REPLACE "-fvisibility-inlines-hidden" "" _src_cmake "${_src_cmake}")
string(REPLACE "add_definitions(-DGRAPHITE2_STATIC)" "add_definitions(-DGRAPHITE2_STATIC)\n    add_definitions(-DGRAPHITE2_EXPORTING)" _src_cmake "${_src_cmake}")
file(WRITE "${SOURCE_PATH}/src/CMakeLists.txt" "${_src_cmake}")

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DDISABLE_TESTS=ON
)

vcpkg_cmake_install()
vcpkg_copy_pdbs()
vcpkg_cmake_config_fixup()
vcpkg_fixup_pkgconfig()

if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    # Do NOT replace with "1" — keep the original check so GRAPHITE2_EXPORTING
    # takes effect and GR2_API = visibility("default")
    message(STATUS "graphite2 overlay: keeping GRAPHITE2_STATIC check in Types.h (GRAPHITE2_EXPORTING overrides)")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")
file(REMOVE "${CURRENT_PACKAGES_DIR}/lib/libgraphite2.la" "${CURRENT_PACKAGES_DIR}/debug/lib/libgraphite2.la")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/COPYING" "${SOURCE_PATH}/LICENSE")
