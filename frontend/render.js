const elements = {
	button: document.querySelector('#process-button'),
	buttonLabel: document.querySelector('#process-button .button-label'),
	input: document.querySelector('#image-input'),
	dropzone: document.querySelector('.dropzone'),
	changeImageButton: document.querySelector('#change-image-button'),
	selection: document.querySelector('#selection'),
	preview: document.querySelector('#preview'),
	filename: document.querySelector('#filename'),
	fileMeta: document.querySelector('#file-meta'),
	uploadError: document.querySelector('#upload-error'),
	jobCard: document.querySelector('#job-card'),
	results: document.querySelector('#results'),
	resultCount: document.querySelector('#result-count'),
};

// Fixed variant contract so pending slots can render before the worker finishes.
const VARIANT_SLOTS = [
	{ name: 'thumbnail', label: 'Thumbnail', target: '150 x 150' },
	{ name: 'preview', label: 'Preview', target: '800 x 600' },
	{ name: 'display', label: 'Display', target: '1200 x 900' },
];

const STATUS_LABELS = {
	uploading: 'Uploading',
	queued: 'Queued',
	processing: 'Processing',
	completed: 'Completed',
	failed: 'Failed',
};

export function render(state) {
	renderSelection(state);
	renderUploadState(state);
	renderJob(state);
	renderResults(state);
}

/* ---------- upload panel ---------- */

function renderSelection(state) {
	const { file, previewUrl } = state;
	const hasValidFile = Boolean(file) && !state.uploadError;
	const pickerHidden = hasValidFile || state.isSubmitting || state.choosingDifferentImage;
	const showChangeButton = hasValidFile || state.choosingDifferentImage;

	elements.uploadError.textContent = state.uploadError;
	elements.input.disabled = state.isSubmitting || (hasValidFile && !state.choosingDifferentImage);
	elements.dropzone.classList.toggle('hidden', pickerHidden);
	elements.selection.classList.toggle('hidden', !hasValidFile);
	elements.changeImageButton.classList.toggle('hidden', !showChangeButton);
	elements.changeImageButton.disabled = state.isSubmitting;

	if (!hasValidFile || !previewUrl) return;

	elements.preview.src = previewUrl;
	elements.filename.textContent = file.name;
	elements.fileMeta.textContent = `${formatBytes(file.size)} · ${mediaTypeLabel(file)}`;
}

function renderUploadState(state) {
	const status = state.job?.status;
	elements.button.disabled =
		state.isSubmitting || Boolean(state.job) || !state.file || Boolean(state.uploadError);

	if (state.isSubmitting) {
		elements.buttonLabel.textContent = 'Uploading...';
		return;
	}
	if (status === 'completed') {
		elements.buttonLabel.textContent = 'Image processed';
		return;
	}
	if (status === 'failed') {
		elements.buttonLabel.textContent = 'Processing failed';
		return;
	}
	elements.buttonLabel.textContent = state.job ? 'Processing image...' : 'Process image';
}

/* ---------- job panel ---------- */

function renderJob(state) {
	const job = state.job;

	if (!job) {
		elements.jobCard.className = 'job-body empty-state';
		elements.jobCard.innerHTML = emptyMarkup('No active job', 'Submit an image to begin.');
		return;
	}

	const status = state.resultError ? 'unknown' : job.status || 'queued';
	const failed = job.status === 'failed';
	const shortId = job.id ? job.id.split('-')[0] : '';

	elements.jobCard.className = `job-body${failed ? ' is-failed' : ''}`;
	elements.jobCard.innerHTML = `
		<div class="job-head">
			<div class="job-identity">
				<p class="job-label">Job ID</p>
				<p class="job-id" title="${escapeHTML(job.id || '')}">${shortId ? `#${escapeHTML(shortId)}` : 'Pending acceptance'}</p>
			</div>
			<span class="badge badge-${status}"><i class="badge-dot"></i>${status === 'unknown' ? 'Not checked' : STATUS_LABELS[job.status] || 'Queued'}</span>
		</div>
		<div class="job-split">
			${timelineHTML(job)}
			${asideHTML(state, job)}
		</div>
	`;
}

// Required job lifecycle: accepted, stored, generating, complete.
// A failure marks the step it stopped at plus the final step.
function timelineHTML(job) {
	const status = job.status;
	const accepted = status !== 'uploading';
	const failed = status === 'failed';

	const steps = [
		{ label: 'Upload accepted', time: job.queued_at, state: accepted ? 'done' : 'current' },
		{ label: 'Original stored', time: job.queued_at, state: accepted ? 'done' : 'pending' },
		{
			label: 'Generating variants',
			time: job.started_at,
			state: status === 'processing' ? 'current' : status === 'completed' ? 'done' : failed ? 'failed' : 'pending',
		},
		{
			label: failed ? 'Failed' : 'Complete',
			time: failed ? job.failed_at : job.completed_at,
			state: status === 'completed' ? 'done' : failed ? 'failed' : 'pending',
		},
	];

	return `<ol class="timeline">${steps
		.map(
			step => `
		<li class="step is-${step.state}">
			<span class="step-marker"></span>
			<div class="step-text"><strong>${step.label}</strong><span class="step-time">${formatTime(step.time) || pendingLabel(step.state)}</span></div>
		</li>`,
		)
		.join('')}</ol>`;
}

// Retrieval error != processing failure — preserve state and offer a retry.
function asideHTML(state, job) {
	if (state.resultError) {
		return `<div class="job-aside">
			<strong class="aside-title">Unable to check status</strong>
			<span class="aside-note">The job may still be running.</span>
			<button class="try-again" type="button">Try again</button>
		</div>`;
	}
	if (job.status === 'completed') {
		return `<div class="job-aside">
			<strong class="aside-title is-good">Processing complete</strong>
			<span class="aside-note">All three variants are ready.</span>
		</div>`;
	}
	if (job.status === 'failed') {
		return `<div class="job-aside">
			<strong class="aside-title is-bad">Processing failed</strong>
			<span class="aside-note job-error">${escapeHTML(job.error || 'The image could not be processed.')}</span>
		</div>`;
	}
	return `<div class="job-aside">
		<span class="polling-dot"></span>
		<strong class="aside-title">Checking status automatically</strong>
		<span class="aside-note">Every 1 second</span>
	</div>`;
}

/* ---------- results panel ---------- */

// UI-14/15, IMG-03: results stay hidden until the job is fully completed.
function renderResults(state) {
	const job = state.job;

	if (!job || job.status === 'uploading') {
		elements.resultCount.textContent = '0 files';
		elements.results.className = 'results empty-state';
		elements.results.innerHTML = emptyMarkup('No images generated yet', 'Completed variants will appear here.');
		return;
	}

	if (job.status === 'failed') {
		elements.resultCount.textContent = '0 files';
		elements.results.className = 'results empty-state';
		elements.results.innerHTML = emptyMarkup('No images generated', 'This job failed, so no variants are available.');
		return;
	}

	if (job.status !== 'completed') {
		elements.resultCount.textContent = '0 files';
		elements.results.className = 'results';
		elements.results.innerHTML = `
			<p class="results-notice"><strong>Images are being generated.</strong> Results will appear when processing completes.</p>
			${VARIANT_SLOTS.map(pendingCardHTML).join('')}
		`;
		return;
	}

	const variants = Array.isArray(state.results)
		? state.results.filter(variant => variant?.url && variant?.name)
		: [];

	if (!variants.length) {
		elements.resultCount.textContent = '0 files';
		elements.results.className = 'results empty-state';
		elements.results.innerHTML = emptyMarkup('No generated variants were returned', 'The job completed without result metadata.');
		return;
	}

	elements.resultCount.textContent = `${variants.length} files`;
	elements.results.className = 'results';
	elements.results.innerHTML = variants.map(readyCardHTML).join('');
}

function readyCardHTML(variant) {
	return `<article class="result">
		<div class="result-frame">
			<img src="${escapeHTML(variant.url)}" alt="${escapeHTML(variant.name)} variant" loading="lazy">
			<span class="pill pill-ready"><i class="pill-dot"></i>Ready</span>
		</div>
		<div class="result-meta">
			<div><strong>${capitalize(variant.name)}</strong><span>${Number(variant.width) || 0} x ${Number(variant.height) || 0}</span></div>
			<a class="download" href="${escapeHTML(variant.url)}" target="_blank" rel="noreferrer">View / download</a>
		</div>
	</article>`;
}

function pendingCardHTML(slot) {
	return `<article class="result is-pending">
		<div class="result-frame">
			<div class="result-placeholder"></div>
			<span class="pill pill-pending"><i class="pill-dot"></i>Pending</span>
		</div>
		<div class="result-meta">
			<div><strong>${slot.label}</strong><span>${slot.target}</span></div>
		</div>
	</article>`;
}

/* ---------- helpers ---------- */

export function bindTryAgain(listener) {
	elements.jobCard.querySelector('.try-again')?.addEventListener('click', listener);
}

function emptyMarkup(title, subtitle) {
	return `<strong>${title}</strong><span>${subtitle}</span>`;
}

function formatTime(value) {
	if (!value) return '';
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? ''
		: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function pendingLabel(state) {
	if (state === 'current') return 'In progress';
	if (state === 'failed') return 'Failed';
	return 'Pending';
}

function capitalize(value) {
	const text = String(value);
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatBytes(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mediaTypeLabel(file) {
	if (file.type === 'image/jpeg') return 'JPEG';
	if (file.type === 'image/png') return 'PNG';
	return file.type || 'type not reported';
}

// Untrusted values are always escaped before going into innerHTML.
function escapeHTML(value) {
	return String(value).replace(
		/[&<>"']/g,
		character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
	);
}