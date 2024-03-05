import { load } from "https://deno.land/std@0.217.0/dotenv/mod.ts";
import { resolve } from "https://deno.land/std@0.217.0/path/mod.ts";
import * as log from "https://deno.land/std@0.217.0/log/mod.ts";
import { Command, program } from "npm:commander@12.0.0";
import { fromFileUrl } from "https://deno.land/std@0.217.0/path/from_file_url.ts";

const env = await load({
	envPath: resolve(import.meta.dirname!, "./.env"),
});

const SF_API_ID = env.SF_API_ID;
const SF_API_SECRET = env.SF_API_SECRET;

log.setup({
	handlers: {
		console: new log.ConsoleHandler("INFO"),
		file: new log.FileHandler("DEBUG", {
			filename: resolve(import.meta.dirname!, "./sfcc-d.log"),
			formatter: (r) => `[${r.datetime.toISOString()}|${r.levelName}] ${r.msg}`,
		}),
	},
	loggers: {
		default: {
			level: "DEBUG",
			handlers: ["console", "file"],
		},
	},
});

async function useCachedResult<T>(
	result: () => Promise<T>,
	storageKey: string,
	maxDuration: Temporal.Duration,
	invalidate: boolean = false,
) {
	const cachedResult = localStorage.getItem(storageKey);
	if (!invalidate && cachedResult) {
		const { value, exp } = JSON.parse(cachedResult) as {
			value: T;
			exp: number;
		};
		log.debug(
			`Retrieved ${storageKey} from cache. Exp: ${
				Temporal.Instant.fromEpochMilliseconds(exp).toString()
			}`,
		);
		if (Date.now() < exp) return value;
	}
	let instant = Temporal.Instant.fromEpochMilliseconds(Date.now());
	instant = instant.add(maxDuration);
	const resultValue = await result();
	localStorage.setItem(
		storageKey,
		JSON.stringify({ value: resultValue, exp: instant.epochMilliseconds }),
	);
	log.debug(`Cached ${storageKey}. Exp: ${instant.toString()}`);

	return resultValue;
}

async function getSfccAuthToken(): Promise<string> {
	const res = await fetch(
		"https://account.demandware.com:443/dwsso/oauth2/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body:
				`grant_type=client_credentials&client_id=${SF_API_ID}&client_secret=${SF_API_SECRET}`,
		},
	);
	const json = await res.json();
	log.debug(`Auth token response ${JSON.stringify(json)}`);
	return json.access_token;
}

type SandboxInfo = {
	id: string;
	realm: string;
	instance: string;
	versions: {
		app: string;
		web: string;
	};
	resourceProfile: string;
	state: string;
	createdAt: string;
	createdBy: string;
	hostName: string;
	links: {
		bm: string;
		ocapi: string;
		impex: string;
		code: string;
		logs: string;
	};
};

async function getSandboxList(sfccAuthToken: string): Promise<SandboxInfo[]> {
	const res = await fetch(
		"https://admin.dx.commercecloud.salesforce.com/api/v1/sandboxes?include_deleted=false",
		{
			headers: {
				Authorization: `Bearer ${sfccAuthToken}`,
				Accept: "application/json",
			},
		},
	);
	const resJson = await res.json();

	if (resJson.code === 200) {
		resJson.data.sort((a: SandboxInfo, b: SandboxInfo) =>
			a.hostName.localeCompare(b.hostName)
		);
		return resJson.data;
	} else {
		console.error(
			"Failed to retrieve sandbox list:",
			resJson.code,
			resJson.error.message,
		);
		Deno.exit(1);
	}
}

let sfccAuthToken: string;

async function updateToken() {
	sfccAuthToken = await useCachedResult(
		getSfccAuthToken,
		"sfccAuthToken",
		Temporal.Duration.from({ minutes: 29, seconds: 55 }),
	);
}

let sandboxList: SandboxInfo[];
async function updateSandboxList(invalidate: boolean = false) {
	sandboxList = await useCachedResult(
		() => getSandboxList(sfccAuthToken),
		"sandboxList",
		Temporal.Duration.from({ hours: 24 * 14 }), // Workaround for bug in Temporal.Duration
		invalidate,
	);
}

async function runSandboxOperation(operation: string, sandboxId: string) {
	const sb = sandboxList.find((sb) => sb.id === sandboxId)!;

	const res = await fetch(
		`https://admin.dx.commercecloud.salesforce.com/api/v1/sandboxes/${sandboxId}/operations`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${sfccAuthToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				operation,
			}),
		},
	);

	if (res.status !== 200 && res.status !== 201) {
		log.error(
			`Failed performing sandbox operation: ${res.status} ${res.statusText}`,
		);
		Deno.exit(1);
	}

	const resJson = await res.json();

	if (resJson.code === 201) {
		log.info(`Triggered ${operation} on ${sb.hostName}`);
	} else {
		log.error(
			`Failed to ${operation} sandbox ${
				sb?.hostName || sandboxId
			}: ${resJson.code} ${resJson.error.message}`,
		);
	}
}

async function getSandboxInfo(sandboxId: string) {
	const sb = sandboxList.find((sb) => sb.id === sandboxId)!;

	const res = await fetch(
		`https://admin.dx.commercecloud.salesforce.com/api/v1/sandboxes/${sandboxId}`,
		{
			headers: {
				Authorization: `Bearer ${sfccAuthToken}`,
				Accept: "application/json",
			},
		},
	);

	if (res.status !== 200) {
		log.error(
			`Failed to retrieve sandbox info: ${res.status} ${res.statusText}`,
		);
		Deno.exit(1);
	}

	const resJson = await res.json();
	log.debug(
		`Sandbox info for ${sb.hostName}: ${JSON.stringify(resJson.data, null, 2)}`,
	);
	return resJson.data;
}

function getSandboxesByString(findStr: string): SandboxInfo[] {
	return sandboxList.filter((sb) =>
		sb.hostName.includes(findStr) || sb.id === findStr
	);
}

async function getRealmCredits(realm: string, from: string, to: string) {
	try {
		const res = await fetch(
			`https://admin.dx.commercecloud.salesforce.com/api/v1/realms/${realm}/usage?from=${from}&to=${to}`,
			{
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${sfccAuthToken}`,
				},
			},
		);
		const resJson = await res.json();
		if (resJson.code !== 200) {
			log.error("Unsuccessful response from realm credits API", resJson);
			Deno.exit(1);
		}
		return resJson.data;
	} catch (e) {
		log.error("Error while getting sandbox usage", e);
		Deno.exit(1);
	}
}

async function run() {
	const fromToRegex = /^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/;
	const monthRegex = /^\d{4}-\d{2}$/;

	function buildSandboxOperationCommand(operation: string) {
		return new Command(operation)
			.argument("<sandbox>", "Sandbox ID or a part of the hostname")
			.action(async function (findStr: string) {
				const sbs = getSandboxesByString(findStr);
				for (const sb of sbs) {
					await runSandboxOperation(operation, sb.id);
				}
			});
	}

	await updateToken();
	await updateSandboxList();

	program
		.name("sfcc-d");

	program
		.command("list")
		.description("List fresh data for all sandboxes")
		.action(async () => {
			await updateSandboxList(true);

			const sandboxInfoLine = sandboxList.map((sb) => {
				let stateEmoji = "";

				if (sb.state === "started") stateEmoji = "🟢";
				else if (sb.state === "stopped") stateEmoji = "🔴";
				else stateEmoji = "🟡";

				return `${sb.id}🔹${sb.hostName}${stateEmoji}${sb.state}`;
			}).join("\n");
			console.log(sandboxInfoLine);
		});

	program.addCommand(buildSandboxOperationCommand("start"));
	program.addCommand(buildSandboxOperationCommand("stop"));
	program.addCommand(buildSandboxOperationCommand("restart"));

	program
		.command("s-info")
		.description("Show detailed info for a sandbox")
		.argument("<sandbox>", "Sandbox ID or a part of the hostname")
		.action(async function (findStr: string) {
			const sbs = getSandboxesByString(findStr);
			for (const sb of sbs) {
				const info = await getSandboxInfo(sb.id);
				console.log(info);
			}
		});

	program
		.command("cred")
		.description("Show credits used by sandboxes for the given realm")
		.argument("<realm>", "Realm name", (v) => {
			if (v.length !== 4) {
				throw new Error("Realm name must be 4 characters long");
			}
			return v;
		})
		.argument("<time>", "Time period", (v) => {
			if (v !== "last-month" && !monthRegex.test(v) && !fromToRegex.test(v)) {
				throw new Error(
					"Invalid time period. Use 'last-month' or 'YYYY-MM' or 'YYYY-MM-DD:YYYY-MM-DD'",
				);
			}
			return v;
		})
		.action(async (realm: string, time: string) => {
			let usage;
			let from;
			let to;
			if (time === "last-month") {
				const now = Temporal.Now.plainDateISO();
				from = now.with({ day: 1 });
				from = from.subtract({ months: 1 });
				to = from.add({ months: 1 }).subtract({ days: 1 });
				usage = await getRealmCredits(realm, from.toString(), to.toString());
			} else if (monthRegex.test(time)) {
				from = `${time}-01`;
				to = Temporal.PlainDate.from(from).add({ months: 1 }).subtract({
					days: 1,
				});
				usage = await getRealmCredits(realm, from, to.toString());
			} else if (fromToRegex.test(time)) {
				[from, to] = time.split(":");
				usage = await getRealmCredits(realm, from, to);
			}
			let msg = `Credits used by ${realm} from ${from} to ${to}:\n`;
			msg += `Minutes up: ${usage.minutesUp}\n`;
			msg += `Minutes down: ${usage.minutesDown}\n`;
			msg += `Credits used: ${
				Math.ceil(usage.minutesUp + usage.minutesDown * 0.3)
			}\n`;
			log.info(msg);
		});

	program.parse();

	log.debug(`args: ${program.args}`);
}

run();
