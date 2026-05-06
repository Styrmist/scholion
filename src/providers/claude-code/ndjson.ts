import { StringDecoder } from "string_decoder";
import * as logger from "../../utils/log";

export async function* lineStream(
	stream: NodeJS.ReadableStream
): AsyncGenerator<unknown, void, void> {
	const decoder = new StringDecoder("utf8");
	let buf = "";
	for await (const chunk of stream as AsyncIterable<string | Buffer>) {
		buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) yield* parseLine(line);
			nl = buf.indexOf("\n");
		}
	}
	buf += decoder.end();
	const tail = buf.trim();
	if (tail) yield* parseLine(tail);
}

function* parseLine(line: string): Generator<unknown> {
	try {
		yield JSON.parse(line);
	} catch (e) {
		logger.warn("Failed to parse NDJSON line", { line, error: (e as Error).message });
	}
}
