package main

import (
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
)

// Stable release builds set this through -ldflags. Development builds retain
// their VCS identity without guessing a version from the running directory.
var version = "development"

func printVersion(output io.Writer) {
	revision := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				revision = setting.Value
			}
		}
	}
	fmt.Fprintf(output, "testspeed %s\nGo: %s\nCommit: %s\n", version, runtime.Version(), revision)
}
