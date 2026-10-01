#!/bin/sh
# A child that starts and then says nothing.
#
# The spawn executor gives a child `startTimeout` to send `ready`; this stands
# in for one that never will. It has to be a real non-responding process rather
# than our own bootstrap racing a small timeout — that version of the test
# passed only because the child took ~56ms to import bun-common's barrel, and
# it broke the moment that import was fixed.
#
# Its arguments (`--no-env-file` under the default environment allowlist, then
# the entry path) are deliberately ignored.
exec sleep 30
