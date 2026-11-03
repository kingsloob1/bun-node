/**
 * The `./webrtc` bundle-safety check's negative control: the WebRTC helpers
 * beside the relay from bun-common, which a browser bundle must never carry.
 * Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { signallingRelay } from "@kingsleyweb/bun-common/webrtc";
import { connectPeer } from "../../lib/webrtc";

export { connectPeer, signallingRelay };
