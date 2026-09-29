#!/bin/sh
# A child whose start-up is held until the test says so.
#
# Waits for the file named by $RUNNER_TEST_GATE, then becomes the real child
# ($RUNNER_TEST_BUN with the entry path and arguments it was given). A test
# stops the run first and opens the gate after, so the stop is certain to
# reach the child before `start` does — no race with how fast Bun boots.
while [ ! -f "$RUNNER_TEST_GATE" ]; do sleep 0.01; done
exec "$RUNNER_TEST_BUN" "$@"
