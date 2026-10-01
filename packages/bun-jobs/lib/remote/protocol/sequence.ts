/**
 * Replay protection after the handshake, on a text transport
 * (`remote-transports.md` §4.4.2), and the acknowledgement rule of §4.4.1.
 *
 * Every text transport is ordered and reliable, so the receiver needs no
 * window: a sequenced frame's `seq` must be exactly one more than the last
 * one delivered.
 *
 * - **Equal to last + 1**: delivered.
 * - **Lower**: a duplicate, dropped silently. Resumption replays the outbox
 *   byte for byte from what the peer says it received, so duplicates are
 *   normal there; the MAC already proved the frame was the peer's.
 * - **Higher**: a gap, which on an ordered transport means a frame was lost
 *   or withheld. The session closes with `SEQUENCE_GAP` and resumes.
 * - **`seq` 0** (`hello`, `welcome`, `ack`): unsequenced, always passed on,
 *   so a bare `ack` can carry its acknowledgement.
 *
 * The peer's `ack` only ever moves forward: a lower one (a replayed bare
 * `ack`, or an old frame) is a no-op. One higher than anything this side has
 * sent is a protocol error, since only the authenticated peer could have
 * written it, and acting on it would drop frames from the outbox that were
 * never acknowledged.
 *
 * Frames are checked here **after** their MAC, never before: an unverified
 * frame must not move the window. Internal; browser-safe.
 */

/** What {@link TextFrameWindow.admit} decided for one verified frame. */
export type FrameVerdict =
  | {
      /** In order: hand it to the session. */
      verdict: "deliver";
      /** How far the peer's acknowledgement moved: `0` when it did not. */
      acked: number;
    }
  | {
      /** `seq` 0: hand it on; it occupies no place in the sequence. */
      verdict: "unsequenced";
      /** How far the peer's acknowledgement moved: `0` when it did not. */
      acked: number;
    }
  | {
      /** Already delivered: drop it silently. Nothing moved. */
      verdict: "duplicate";
    }
  | {
      /** A frame is missing before this one: close with `SEQUENCE_GAP`. Nothing moved. */
      verdict: "gap";
      /** The `seq` that was due. */
      expected: number;
      /** The `seq` that came. */
      received: number;
    }
  | {
      /** The peer acknowledges a `seq` this side never sent: a protocol error. Nothing moved. */
      verdict: "ack-ahead";
      /** The highest `seq` this side has sent. */
      sent: number;
      /** The `ack` that came. */
      received: number;
    };

/**
 * One direction's receive state in one session: what has been delivered
 * from the peer, and how much of this side's output the peer has
 * acknowledged. A new session starts at zero; a resumed one carries its
 * window over.
 */
export class TextFrameWindow {
  /** The last `seq` delivered: the `ack` this side sends next. */
  delivered: number;
  /** The highest `ack` the peer has sent: this side's frames up to it may leave the outbox. */
  peerAck: number;

  constructor(
    /** Where a resumed session's state starts; both `0` for a new one. */
    start?: {
      /** The last `seq` delivered before. */
      delivered?: number;
      /** The highest `ack` received before. */
      peerAck?: number;
    },
  ) {
    this.delivered = start?.delivered ?? 0;
    this.peerAck = start?.peerAck ?? 0;
  }

  /**
   * Decides what to do with one frame that has already verified.
   * `sent` is the highest `seq` this side has sent so far; omitted, the
   * peer's `ack` is not bounded (a receive-only stream, which sends nothing).
   */
  admit(
    frame: {
      /** The frame's `seq`. */
      seq: number;
      /** The frame's `ack`. */
      ack: number;
    },
    sent?: number,
  ): FrameVerdict {
    const { seq, ack } = frame;
    if (seq !== 0) {
      if (seq <= this.delivered) {
        return { verdict: "duplicate" };
      }
      if (seq !== this.delivered + 1) {
        return { verdict: "gap", expected: this.delivered + 1, received: seq };
      }
    }
    if (sent !== undefined && ack > sent) {
      return { verdict: "ack-ahead", sent, received: ack };
    }
    if (seq !== 0) {
      this.delivered = seq;
    }
    const acked = ack > this.peerAck ? ack - this.peerAck : 0;
    if (acked > 0) {
      this.peerAck = ack;
    }
    return { verdict: seq === 0 ? "unsequenced" : "deliver", acked };
  }
}
