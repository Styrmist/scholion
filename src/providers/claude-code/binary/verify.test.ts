import * as openpgp from "openpgp";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyManifestSignature } from "./verify";

interface KeyPair {
	privateArmored: string;
	publicArmored: string;
}

async function generateKeyPair(): Promise<KeyPair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: "rsa",
		rsaBits: 2048,
		userIDs: [{ name: "Test", email: "test@example.com" }],
		format: "armored",
	});
	return { privateArmored: privateKey, publicArmored: publicKey };
}

async function detachedSign(message: string, privateArmored: string): Promise<string> {
	const privateKey = await openpgp.readPrivateKey({ armoredKey: privateArmored });
	const sig = await openpgp.sign({
		message: await openpgp.createMessage({ text: message }),
		signingKeys: privateKey,
		detached: true,
		format: "armored",
	});
	return sig as string;
}

describe("verifyManifestSignature", () => {
	let pair: KeyPair;
	let manifestText: string;
	let goodSig: string;

	beforeAll(async () => {
		pair = await generateKeyPair();
		manifestText = JSON.stringify({ version: "1.0.0", platforms: {} });
		goodSig = await detachedSign(manifestText, pair.privateArmored);
	}, 30_000);

	it("resolves when signature is valid for the supplied public key", async () => {
		await expect(
			verifyManifestSignature(manifestText, goodSig, pair.publicArmored),
		).resolves.toBeUndefined();
	});

	it("throws when signature is over a different message", async () => {
		await expect(
			verifyManifestSignature(manifestText + "tampered", goodSig, pair.publicArmored),
		).rejects.toThrow(/did not verify/);
	});

	it("throws when signature was made by a different key", async () => {
		const other = await generateKeyPair();
		await expect(
			verifyManifestSignature(manifestText, goodSig, other.publicArmored),
		).rejects.toThrow();
	});

	it("throws on a malformed armored signature", async () => {
		await expect(
			verifyManifestSignature(manifestText, "not a real signature", pair.publicArmored),
		).rejects.toThrow();
	});

	it("throws on a malformed armored public key", async () => {
		await expect(
			verifyManifestSignature(manifestText, goodSig, "not a real key"),
		).rejects.toThrow();
	});
});
