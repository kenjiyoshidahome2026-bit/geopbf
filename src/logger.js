export class Logger {
	constructor() {
		this.time;
		this.styles = {
			title: 'background: #2c3e50; color: #ecf0f1; padding: 2px 10px; border-radius: 5px; font-size: 1.5em;',
			info: 'color: #3498db; font-weight: bold;',
			success: 'color: #2ecc71; font-weight: bold;',
			warn: 'color: #f1c40f; font-weight: bold;',
			error: 'color: #e74c3c; font-weight: bold;',
			perf: 'color: #00FFFF; font-weight: bold;', // For timing
			data: 'color: #e67e22; font-weight: bold;',    // For counts/sizes
			inherit: 'color: inherit;',
		};
		this.icons = {
			pbf: "📥", anchor: "⚓", adaptive: "🌀",
			vw: "🧠", check: "✅", boost: "🚀",
			dead: "👻", alert: "🚨", time: "⏱️",
			star: "✨"
		};
	}
	title(message) { this.time = performance.now();
		console.log(`%c ${this.icons.star} ${message.toUpperCase()} ${this.icons.star} `, this.styles.title);
	}
	progress(iconName, current, total, label = "Processing") {
		const percent = Math.min(100, Math.round((current / total) * 100));
		if (current % Math.ceil(total / 10) === 0 || current === total) {
			const bar = "▓".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));
			const icon = this.icons[iconName] || "⏳";
			console.log(`${icon} ${label}: [${bar}] ${percent}% (${current.toLocaleString()}/${total.toLocaleString()})`);
		}
	}
	log(type, iconName, msg) {
		const icon = this.icons[iconName] || "🔔";
		const style = this.styles[type] || this.styles.info;
		console.log(`%c${icon} ${type.toUpperCase()}`, this.styles.base + style, msg);
	}
	info(icon, msg)    { this.log("info", icon, msg); }
	success(msg)       { this.log("success", "check", msg); }
	warn(msg)          { this.log("warn", "alert", msg); }
	error(msg)         { this.log("error", "dead", msg); }
	data(label, count) {
		console.log(`%c${this.icons.anchor} [DATA] %c${label}: %c${count.toLocaleString()}%c`,
			this.styles.data, this.styles.inherit, 'font-weight: bold;', 'font-weight: 400;');
	}
	success(msg) { const time = (performance.now() - this.time).toFixed(2); this.time = performance.now();
		console.log(`%c${this.icons.check} [SUCCESS] %c${msg} in %c${time}%c [msec]`,
			this.styles.success, this.styles.inherit, this.styles.perf, this.styles.inherit);
	}
	measure(label, fn) {
		const start = performance.now();
		const result = fn();
		const end = (performance.now() - start).toFixed(2);
		console.log(`%c${this.icons.time} [PERF] %c${label} completed in %c${end}%c [msec]`,
			this.styles.perf, this.styles.inherit, this.styles.perf, this.styles.inherit);
	   return result;
	}
	async measureAsync(label, fn) {
		const start = performance.now();
		const result = await fn();
		const end = (performance.now() - start).toFixed(2);
		console.log(`%c${this.icons.time} [PERF] %c${label} completed in %c${end}%c [msec]`,
			this.styles.perf, this.styles.inherit, this.styles.perf, this.styles.inherit);
		return result;
	}
}