/** An active PF anchor is not proof that an arbitrary Apple NAT/provider uses it.
 * No generic acknowledgement/profile flag can grant this capability. Activation
 * needs a concrete host-side adapter that checks the provider's actual network,
 * devices, shares and lifecycle. That adapter cannot be certified from Linux.
 */
export async function requireVerifiedNativeProvider():Promise<void>{
 throw Error('Native Vagrant activation is gated: its provider network path and host folder devices have not been verified on macOS. No tunnel or gateway was opened. Use the local service meanwhile; inspect-vagrant reports the provider needed for integration.');
}
