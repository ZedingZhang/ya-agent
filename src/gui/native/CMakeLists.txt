cmake_minimum_required(VERSION 3.15)
if(CMAKE_HOST_APPLE AND NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")
endif()
project(ya_folder_identity LANGUAGES C)
add_executable(ya-folder-identity folder-identity.c)
add_executable(ya-folder-move folder-move.c)
add_executable(ya-grant-commit grant-commit.c)
if(WIN32)
  target_link_libraries(ya-folder-move PRIVATE ntdll)
endif()
set_target_properties(ya-folder-identity ya-folder-move ya-grant-commit PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../../dist/gui-native/$<0:>")
