/*
 * 与服务端 JSON API 的唯一通道。
 *
 * 只用 fetch，不引 axios 之类的库；非 2xx 时把服务端给的 error 字段抛成异常，
 * 调用方统一用 try/catch 处理并写进状态栏。
 */

/** 统一的 fetch 封装：非 2xx 时把服务端的错误信息抛出来 */
export async function api(path, options = {}) {
	const response = await fetch(path, {
		method: options.method ?? "GET",
		headers: options.body ? { "content-type": "application/json" } : undefined,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const text = await response.text();
	const data = text ? JSON.parse(text) : {};
	if (!response.ok) {
		const error = new Error(data.error ?? `请求失败：HTTP ${response.status}`);
		// 少数分支要按状态码分流（例如 501 表示系统没有文件夹选择框，需要退回网页浏览）。
		error.status = response.status;
		throw error;
	}
	return data;
}
