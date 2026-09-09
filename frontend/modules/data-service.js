const acceptedStatus = 202;

export async function uploadImage(file) {
	const body = new FormData();
	body.append('image', file);

	const response = await fetch('/v1/images', { method: 'POST', body });
	const data = await readJson(response);
	if (!response.ok || response.status !== acceptedStatus) {
		throw new Error(data.error || 'The image could not be accepted.');
	}

	return data;
}

export async function getJob(statusUrl, signal) {
	const response = await fetch(statusUrl, { signal });
	if (!response.ok) {
		throw new Error('Unable to check status.');
	}

	return response.json();
}

async function readJson(response) {
	return response.json().catch(() => ({}));
}
