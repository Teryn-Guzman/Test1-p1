const form = document.querySelector('#upload-form');
const input = document.querySelector('#image-input');
const button = document.querySelector('#process-button');
const selection = document.querySelector('#selection');
const preview = document.querySelector('#preview');
const filename = document.querySelector('#filename');
const fileMeta = document.querySelector('#file-meta');
const uploadError = document.querySelector('#upload-error');
const jobCard = document.querySelector('#job-card');
const results = document.querySelector('#results');
const resultCount = document.querySelector('#result-count');
let isSubmitting = false;
let pollController = null;
let observedJob = null;

input.addEventListener('change', () => {
	const file = input.files[0];
	uploadError.textContent = '';
	if (!file) { selection.classList.add('hidden'); button.disabled = true; return; }
	if (!isSupportedImage(file) || file.size > 10 * 1024 * 1024) { uploadError.textContent = 'Choose a JPEG or PNG no larger than 10 MB.'; selection.classList.add('hidden'); button.disabled = true; return; }
	preview.src = URL.createObjectURL(file); filename.textContent = file.name; fileMeta.textContent = `${formatBytes(file.size)} / ${file.type}`; selection.classList.remove('hidden'); button.disabled = false;
});

form.addEventListener('submit', submitImage);
async function submitImage(event) {
	event.preventDefault();
	if (isSubmitting) return;
	const file = input.files[0]; if (!file) return;
	isSubmitting = true; button.disabled = true; button.innerHTML = 'Uploading... <span class="spinner"></span>'; uploadError.textContent = '';
	cancelPolling(); observedJob = null; renderJob({ status: 'uploading' }); results.innerHTML = '<strong>Images are being generated</strong><span>Results will appear when processing completes.</span>'; resultCount.textContent = '0 files';
	try {
		const body = new FormData(); body.append('image', file);
		const response = await fetch('/v1/images', { method: 'POST', body });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || response.status !== 202) throw new Error(data.error || 'The image could not be accepted.');
		observedJob = { id: data.job_id, statusUrl: data.status_url, status: data.status }; renderJob({ id: data.job_id, status: data.status }); pollJob();
	} catch (error) {
		const message = error instanceof TypeError ? 'Could not reach the image API. Make sure the Go server is running at http://localhost:4000.' : error.message;
		uploadError.textContent = message;
		jobCard.className = 'job-content failed';
		jobCard.innerHTML = `<div class="status-row"><span class="badge failed">UPLOAD ERROR</span></div><strong>Upload was not accepted</strong><span>${escapeHTML(message)}</span>`;
	}
	finally { isSubmitting = false; button.textContent = 'Process image ->'; button.disabled = !input.files[0]; }
}

async function pollJob() {
	if (!observedJob) return; cancelPolling(); pollController = new AbortController();
	try {
		const response = await fetch(observedJob.statusUrl, { signal: pollController.signal }); if (!response.ok) throw new Error('Unable to check status.');
		const job = await response.json(); observedJob.status = job.status; renderJob(job); if (job.status === 'completed') { renderResults(job.variants || []); return; } if (job.status === 'failed') return;
		setTimeout(pollJob, 1000);
	} catch (error) { if (error.name === 'AbortError') return; renderJobError(); }
}

function renderJob(job) { if (!job) { jobCard.className = 'empty-state'; jobCard.innerHTML = '<strong>No active job</strong><span>Submit an image to begin.</span>'; return; } if (job.status === 'uploading') { jobCard.innerHTML = '<div class="status-row"><span class="badge active">UPLOADING</span></div><strong>Uploading...</strong><span>Storing the original before acceptance.</span>'; return; } const failed = job.status === 'failed'; const status = escapeHTML(job.status); const id = escapeHTML(job.id || ''); const message = escapeHTML(job.error || 'The image could not be processed.'); jobCard.className = `job-content ${failed ? 'failed' : ''}`; jobCard.innerHTML = `<div class="status-row"><span class="badge ${status}">${status}</span>${id ? `<code>${id}</code>` : ''}</div><strong>${failed ? 'Processing failed' : job.status === 'completed' ? 'Processing complete' : 'Generating variants'}</strong><span>${failed ? message : job.status === 'completed' ? 'All three variants are ready.' : 'Checking status automatically / Every 1 second'}</span><div class="timeline"><span class="done">Upload accepted</span><span class="done">Original stored</span><span class="${job.status === 'processing' ? 'current' : job.status === 'completed' ? 'done' : ''}">Generating variants</span><span class="${job.status === 'completed' ? 'done' : ''}">Complete</span></div>`; }
function renderJobError() { jobCard.className = 'job-content failed'; jobCard.innerHTML = `<div class="status-row"><span class="badge failed">OBSERVATION ERROR</span></div><strong>Unable to check status</strong><span>The job may still be running.</span><button class="try-again" type="button">Try again</button>`; jobCard.querySelector('button').addEventListener('click', pollJob); }
function renderResults(variants) {
	const validVariants = Array.isArray(variants) ? variants.filter(variant => variant && variant.url && variant.name) : [];
	resultCount.textContent = `${validVariants.length} files`;
	if (!validVariants.length) {
		results.className = 'results empty-state';
		results.innerHTML = '<strong>No generated variants were returned</strong><span>The job completed without result metadata.</span>';
		return;
	}
	results.className = 'results';
	results.innerHTML = validVariants.map(variant => `<article class="result"><img src="${escapeHTML(variant.url)}" alt="${escapeHTML(variant.name)} variant"><div><strong>${escapeHTML(variant.name)}</strong><span>${Number(variant.width) || 0} x ${Number(variant.height) || 0}px</span><a href="${escapeHTML(variant.url)}" target="_blank" rel="noreferrer">View / download</a></div></article>`).join('');
	results.querySelectorAll('img').forEach(image => image.addEventListener('error', () => { image.alt = 'Generated image unavailable'; image.parentElement.insertAdjacentHTML('beforeend', '<span class="error">Image could not be loaded.</span>'); }));
}
function cancelPolling() { if (pollController) { pollController.abort(); pollController = null; } }
function formatBytes(bytes) { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
function isSupportedImage(file) {
	const extension = file.name.toLowerCase().split('.').pop();
	return ['image/jpeg', 'image/png', '', 'application/octet-stream'].includes(file.type) && ['jpg', 'jpeg', 'png'].includes(extension);
}
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
window.addEventListener('beforeunload', cancelPolling);

