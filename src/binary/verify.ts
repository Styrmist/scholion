import * as openpgp from "openpgp";
import { CLAUDE_CODE_PUBLIC_KEY_ASC } from "./signingKey";

/**
 * Verify a detached PGP signature against a manifest payload using
 * Anthropic's embedded public key. Throws on any failure path:
 * malformed input, key mismatch, expired/revoked key, bad signature.
 */
export async function verifyManifestSignature(manifestText: string, signatureArmored: string): Promise<void> {
	const publicKey = await openpgp.readKey({ armoredKey: CLAUDE_CODE_PUBLIC_KEY_ASC });
	const message = await openpgp.createMessage({ text: manifestText });
	const signature = await openpgp.readSignature({ armoredSignature: signatureArmored });
	const verification = await openpgp.verify({
		message,
		signature,
		verificationKeys: publicKey,
	});
	const result = verification.signatures[0];
	if (!result) throw new Error("Manifest signature: no signature packet found");
	try {
		await result.verified;
	} catch (e) {
		throw new Error(`Manifest signature did not verify: ${(e as Error).message}`);
	}
}
