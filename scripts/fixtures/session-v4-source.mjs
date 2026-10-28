// Admission functions captured from desktop 0.2.1-rc.2, not the restart implementation.
// @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js module SHA-256:
// a6b974d110572bd0b16aa7ab09a30d9061944e8dc9f811e8c4a35e4891f83f12
// SessionFormatError is represented by Error; the admission function body is unchanged.
const SessionFormatError = Error
function isSessionFormatJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function source(message) {
	const value = message["source"];
	if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string" || value["kind"].length === 0 || value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
export { source as assertV4MessageSource }
