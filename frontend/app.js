import { uploadImage, getJob } from './modules/data-service.js';
import { AppState } from './state.js';
import { bindTryAgain, render } from './render.js';

const form = document.querySelector('#upload-form');
const input = document.querySelector('#image-input');
const changeImageButton = document.querySelector('#change-image-button');
const state = new AppState();
let pollController = null;
let pollTimer = null;

state.on('change', nextState => {
	render(nextState);
	bindTryAgain(pollJob);
});
render(state.get());

input.addEventListener('change', handleFileSelection);
changeImageButton.addEventListener('click', chooseDifferentImage);
form.addEventListener('submit', submitImage);
window.addEventListener('beforeunload', cancelPolling);

function chooseDifferentImage() {
	cancelPolling();
	input.value = '';
	input.disabled = false;
	input.click();
	state.update({
		file: null,
		previewUrl: '',
		uploadError: '',
		isSubmitting: false,
		job: null,
		results: [],
		resultError: '',
		observing: false,
		measurements: null,
		choosingDifferentImage: true,
	});
}

function handleFileSelection() {
	const file = input.files[0] || null;
	cancelPolling();
	state.resetJob();

	if (!file) {
		state.update({ file: null, previewUrl: '', uploadError: '', choosingDifferentImage: false });
		return;
	}

	const validationError = validateFile(file);
	if (validationError) {
		state.update({ file, previewUrl: '', uploadError: validationError, choosingDifferentImage: false });
		return;
	}

	state.update({ file, previewUrl: URL.createObjectURL(file), uploadError: '', choosingDifferentImage: false });
}

async function submitImage(event) {
	event.preventDefault();
	const current = state.get();
	if (current.isSubmitting || current.job || !current.file || current.uploadError) return;

	cancelPolling();
	const requestStartedAt = performance.now();
	state.update({
		isSubmitting: true,
		job: { status: 'uploading' },
		results: [],
		resultError: '',
		measurements: { acknowledgementLatencyMs: null, pollCount: 0, detectionDelayMs: null },
	});

	try {
		const data = await uploadImage(current.file);
		state.update({
			isSubmitting: false,
			job: { id: data.job_id, statusUrl: data.status_url, status: data.status },
			observing: true,
			measurements: {
				acknowledgementLatencyMs: performance.now() - requestStartedAt,
				pollCount: 0,
				detectionDelayMs: null,
			},
		});
		void pollJob();
	} catch (error) {
		const message = error instanceof TypeError
			? 'Could not reach the image API. Make sure the Go server is running at http://localhost:4000.'
			: error.message;
		state.update({ isSubmitting: false, uploadError: message, job: null });
	} finally {
		state.update({ isSubmitting: false });
	}
}

async function pollJob() {
	const current = state.get();
	if (!current.job?.statusUrl || current.job.status === 'completed' || current.job.status === 'failed') return;

	cancelPolling();
	const controller = new AbortController();
	pollController = controller;
	const measurements = current.measurements || { acknowledgementLatencyMs: null, pollCount: 0, detectionDelayMs: null };
	state.update({
		observing: true,
		resultError: '',
		measurements: { ...measurements, pollCount: measurements.pollCount + 1 },
	});

	try {
		const job = await getJob(current.job.statusUrl, controller.signal);
		if (controller.signal.aborted) return;
		const terminal = job.status === 'completed' || job.status === 'failed';
		const terminalAt = job.status === 'completed' ? job.completed_at : job.status === 'failed' ? job.failed_at : null;
		const detectionDelayMs = terminalAt ? Math.max(0, Date.now() - new Date(terminalAt).getTime()) : null;
		if (terminal) stopPolling();
		state.update({
			job: { ...state.get().job, ...job },
			results: job.variants || [],
			observing: !terminal,
			resultError: '',
			measurements: { ...state.get().measurements, detectionDelayMs },
		});
		if (!terminal && (job.status === 'queued' || job.status === 'processing')) {
			pollTimer = setTimeout(pollJob, 1000);
		} else if (!terminal) {
			stopPolling();
			state.update({ observing: false, resultError: 'The job returned an unrecognized status.' });
		}
	} catch (error) {
		if (error.name === 'AbortError') return;
		stopPolling();
		state.update({ observing: false, resultError: 'Unable to check status.' });
	} finally {
		if (pollController === controller) pollController = null;
	}
}

function cancelPolling() {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
	if (pollController) {
		pollController.abort();
		pollController = null;
	}
}

function stopPolling() {
	cancelPolling();
}

function isSupportedImage(file) {
	const extension = file.name.toLowerCase().split('.').pop();
	return ['image/jpeg', 'image/png', '', 'application/octet-stream'].includes(file.type)
		&& ['jpg', 'jpeg', 'png'].includes(extension);
}

function validateFile(file) {
	if (file.size === 0) return 'The selected file is empty.';
	if (file.size > 10 * 1024 * 1024) return 'The selected file is larger than the 10 MB limit.';

	const extension = file.name.toLowerCase().split('.').pop();
	if (!['jpg', 'jpeg', 'png'].includes(extension)) {
		return 'Unsupported file type. Choose a .jpg, .jpeg, or .png image.';
	}

	if (!isSupportedImage(file)) {
		return 'The selected file is not recognized as a JPEG or PNG image.';
	}

	return '';
}