import type { Backend } from "./types";
import type { BackendId } from "./ids";

export class BackendRegistry {
	private readonly backends = new Map<BackendId, Backend>();
	private defaultId?: BackendId;

	register(backend: Backend): void {
		const id = backend.id();
		if (this.backends.has(id)) {
			throw new Error(`Backend ${id} already registered`);
		}
		this.backends.set(id, backend);
		if (this.defaultId === undefined) this.defaultId = id;
	}

	get(id: BackendId): Backend {
		const b = this.backends.get(id);
		if (!b) throw new Error(`Backend ${id} not registered`);
		return b;
	}

	tryGet(id: BackendId): Backend | undefined {
		return this.backends.get(id);
	}

	has(id: BackendId): boolean {
		return this.backends.has(id);
	}

	list(): readonly Backend[] {
		return [...this.backends.values()];
	}

	default(): Backend {
		if (!this.defaultId) throw new Error("No backend registered");
		return this.get(this.defaultId);
	}

	setDefault(id: BackendId): void {
		if (!this.backends.has(id)) {
			throw new Error(`Cannot set default to unregistered backend ${id}`);
		}
		this.defaultId = id;
	}
}
