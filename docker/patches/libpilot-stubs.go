// SPDX-License-Identifier: AGPL-3.0-or-later
//
// libpilot-stubs.go — LOCAL BUILD PATCH (copied into the libpilot checkout by
// docker/libpilot.Dockerfile). NOT an upstream file.
//
// The sdk-node FFI (local 1.9.1 / npm 1.10.2) declares three C functions via
// koffi that org/libpilot@HEAD does not yet //export — the org repos are
// versioned inconsistently and the SDK is ahead of libpilot. koffi resolves ALL
// declared symbols EAGERLY at load, so one missing symbol aborts Driver
// construction. Our ideon-article wrapper never calls these three (it uses only
// connect/listen/accept/read/write/setHostname/setVisibility), so these no-op
// stubs exist purely to satisfy symbol resolution. If a future libpilot exports
// them, delete this patch.
package main

/*
#include <stdint.h>
*/
import "C"

import "fmt"

//export PilotSetTaskExec
func PilotSetTaskExec(h C.uint64_t, en C.int) *C.char {
	return errJSON(fmt.Errorf("PilotSetTaskExec: not implemented in this libpilot build"))
}

//export PilotManagedScore
func PilotManagedScore(h C.uint64_t, net C.uint16_t, kind C.uint32_t, delta C.int32_t, reason *C.char) *C.char {
	return errJSON(fmt.Errorf("PilotManagedScore: not implemented in this libpilot build"))
}

//export PilotManagedRankings
func PilotManagedRankings(h C.uint64_t, net C.uint16_t) *C.char {
	return errJSON(fmt.Errorf("PilotManagedRankings: not implemented in this libpilot build"))
}
