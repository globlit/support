/** Blocks activation until a host-side provider adapter exists. */
export async function requireVerifiedNativeProvider():Promise<void>{
 throw Error('Native Vagrant activation is gated: vagrant-tart 1.0.0 is identified, but the running Tart folder and device boundary still requires validation on this Mac. No tunnel or gateway was opened. Use the Mac companion VM connection checks; local-service mode is unchanged.');
}
