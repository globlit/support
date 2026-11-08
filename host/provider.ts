/** An active PF anchor is not proof that an arbitrary Apple NAT/provider uses it.
 * No generic acknowledgement/profile flag can grant this capability. Activation
 * needs a concrete host-side adapter that checks the provider's actual network,
 * devices, shares and lifecycle. That adapter cannot be certified from Linux.
 */
export async function requireVerifiedNativeProvider():Promise<void>{
 throw Error('Native Vagrant activation is gated: vagrant-tart 1.0.0 is identified, but the running Tart/Softnet network and folder boundary still requires validation on this Mac. No tunnel or gateway was opened. Use Check provider and the Tart setup guide; local-service mode is unchanged.');
}
