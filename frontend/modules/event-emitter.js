export class EventEmitter {
	constructor() {
		this.listeners = new Map();
	}

	on(eventName, listener) {
		if (!this.listeners.has(eventName)) {
			this.listeners.set(eventName, new Set());
		}

		this.listeners.get(eventName).add(listener);
		return () => this.off(eventName, listener);
	}

	off(eventName, listener) {
		this.listeners.get(eventName)?.delete(listener);
	}

	emit(eventName, payload) {
		this.listeners.get(eventName)?.forEach(listener => listener(payload));
	}
}
