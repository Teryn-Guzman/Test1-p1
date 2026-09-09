const elements = {
	button: document.querySelector('#process-button'),
	selection: document.querySelector('#selection'),
	preview: document.querySelector('#preview'),
	filename: document.querySelector('#filename'),
	fileMeta: document.querySelector('#file-meta'),
	uploadError: document.querySelector('#upload-error'),
	jobCard: document.querySelector('#job-card'),
	results: document.querySelector('#results'),
	resultCount: document.querySelector('#result-count'),
};

export function render(state) {
	renderSelection(state);
	renderUploadState(state);
	renderJob(state);
	renderResults(state);
}

function renderSelection(state) {
	const { file, previewUrl } = state;
	elements.uploadError.textContent = state.uploadError;
	elements.selection.classList.toggle('hidden', !file || Boolean(state.uploadError));
	if (!file || !previewUrl) return;

	elements.preview.src = previewUrl;
	elements.filename.textContent = file.name;
	elements.fileMeta.textContent = `${formatBytes(file.size)} / ${file.type || 'type not reported'}`;
}

function renderUploadState(state) {
	elements.button.disabled = state.isSubmitting || !state.file || Boolean(state.uploadError);
	elements.button.innerHTML = state.isSubmitting
		? 'Uploading... <span class="spinner"></span>'
		: 'Process image <span>-></span>';
}

function renderJob(state) {
	const job = state.job;
	if (!job) {
		elements.jobCard.className = 'empty-state';
		elements.jobCard.innerHTML = '<strong>No active job</strong><span>Submit an image to begin.</span>';
		return;
	}

	if (job.status === 'uploading') {
		elements.jobCard.className = 'job-content';
		elements.jobCard.innerHTML = '<div class="status-row"><span class="badge active">UPLOADING</span></div><strong>Uploading...</strong><span>Storing the original before acceptance.</span>';
		return;
	}

	if (state.resultError) {
		elements.jobCard.className = 'job-content failed';
		elements.jobCard.innerHTML = '<div class="status-row"><span class="badge failed">OBSERVATION ERROR</span></div><strong>Unable to check status</strong><span>The job may still be running.</span><button class="try-again" type="button">Try again</button>';
		return;
	}

	const failed = job.status === 'failed';
	const status = escapeHTML(job.status || 'queued');
	const id = escapeHTML(job.id || '');
	const message = escapeHTML(job.error || 'The image could not be processed.');
	elements.jobCard.className = `job-content ${failed ? 'failed' : ''}`;
	elements.jobCard.innerHTML = `<div class="status-row"><span class="badge ${status}">${status}</span>${id ? `<code>${id}</code>` : ''}</div><strong>${failed ? 'Processing failed' : job.status === 'completed' ? 'Processing complete' : 'Generating variants'}</strong><span>${failed ? message : job.status === 'completed' ? 'All three variants are ready.' : 'Checking status automatically / Every 1 second'}</span><div class="timeline"><span class="done">Upload accepted</span><span class="done">Original stored</span><span class="${job.status === 'processing' ? 'current' : job.status === 'completed' ? 'done' : ''}">Generating variants</span><span class="${job.status === 'completed' ? 'done' : ''}">Complete</span></div>`;
}

function renderResults(state) {
	const variants = Array.isArray(state.results) ? state.results.filter(variant => variant?.url && variant?.name) : [];
	elements.resultCount.textContent = `${variants.length} files`;

	if (!variants.length) {
		elements.results.className = 'results empty-state';
		elements.results.innerHTML = state.job?.status === 'completed'
			? '<strong>No generated variants were returned</strong><span>The job completed without result metadata.</span>'
			: '<strong>No images generated yet</strong><span>Completed variants will appear here.</span>';
		return;
	}

	elements.results.className = 'results';
	elements.results.innerHTML = variants.map(variant => `<article class="result"><img src="${escapeHTML(variant.url)}" alt="${escapeHTML(variant.name)} variant"><div><strong>${escapeHTML(variant.name)}</strong><span>${Number(variant.width) || 0} x ${Number(variant.height) || 0}px</span><a href="${escapeHTML(variant.url)}" target="_blank" rel="noreferrer">View / download</a></div></article>`).join('');
}

export function bindTryAgain(listener) {
	elements.jobCard.querySelector('.try-again')?.addEventListener('click', listener);
}

function formatBytes(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHTML(value) {
	return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
