import { EventEmitter } from './modules/event-emitter.js';

const initialState = {
	file: null,
	previewUrl: '',
	uploadError: '',
	isSubmitting: false,
	job: null,
	results: [],
	resultError: '',
	observing: false,
};

export class AppState extends EventEmitter {
	constructor() {
		super();
		this.value = { ...initialState };
	}

	get() {
		return this.value;
	}

	update(changes) {
		this.value = { ...this.value, ...changes };
		this.emit('change', this.value);
	}

	resetJob() {
		this.update({ job: null, results: [], resultError: '', observing: false });
	}
}
