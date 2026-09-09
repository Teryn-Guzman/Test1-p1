import { uploadImage, getJob } from './modules/data-service.js';
import { AppState } from './state.js';
import { bindTryAgain, render } from './render.js';

const form = document.querySelector('#upload-form');
const input = document.querySelector('#image-input');
const state = new AppState();
let pollController = null;
let pollTimer = null;

state.on('change', nextState => {
	render(nextState);
	bindTryAgain(pollJob);
});
render(state.get());

input.addEventListener('change', handleFileSelection);
form.addEventListener('submit', submitImage);
window.addEventListener('beforeunload', cancelPolling);

function handleFileSelection() {
	const file = input.files[0] || null;
	cancelPolling();
	state.resetJob();

	if (!file) {
		state.update({ file: null, previewUrl: '', uploadError: '' });
		return;
	}

	if (!isSupportedImage(file) || file.size > 10 * 1024 * 1024) {
		state.update({ file, previewUrl: '', uploadError: 'Choose a JPEG or PNG no larger than 10 MB.' });
		return;
	}

	state.update({ file, previewUrl: URL.createObjectURL(file), uploadError: '' });
}

async function submitImage(event) {
	event.preventDefault();
	const current = state.get();
	if (current.isSubmitting || !current.file || current.uploadError) return;

	cancelPolling();
	state.update({ isSubmitting: true, job: { status: 'uploading' }, results: [], resultError: '' });

	try {
		const data = await uploadImage(current.file);
		state.update({
			isSubmitting: false,
			job: { id: data.job_id, statusUrl: data.status_url, status: data.status },
			observing: true,
		});
		pollJob();
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
	pollController = new AbortController();
	try {
		const job = await getJob(current.job.statusUrl, pollController.signal);
		state.update({
			job: { ...current.job, ...job },
			results: job.status === 'completed' ? job.variants || [] : [],
			observing: job.status === 'queued' || job.status === 'processing',
			resultError: '',
		});
		if (job.status === 'queued' || job.status === 'processing') {
			pollTimer = setTimeout(pollJob, 1000);
		}
	} catch (error) {
		if (error.name === 'AbortError') return;
		state.update({ observing: false, resultError: 'Unable to check status.' });
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

function isSupportedImage(file) {
	const extension = file.name.toLowerCase().split('.').pop();
	return ['image/jpeg', 'image/png', '', 'application/octet-stream'].includes(file.type)
		&& ['jpg', 'jpeg', 'png'].includes(extension);
}
