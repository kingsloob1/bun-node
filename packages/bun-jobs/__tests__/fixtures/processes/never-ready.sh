#!/bin/sh
# A child that starts and then says nothing.
#
# The spawn executor gives a child `startTimeout` to send `ready`; this stands
# in for one that never will. It has to be a real non-responding process rather
# than our own bootstrap racing a small timeout — that version of the test
# passed only because the child took ~56ms to import bun-common's barrel, and
# it broke the moment that import was fixed.
#
# The entry path arrives as $1 and is deliberately ignored.
exec sleep 30
