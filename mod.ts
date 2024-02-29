import { load } from "https://deno.land/std@0.217.0/dotenv/mod.ts";
import { resolve } from "https://deno.land/std@0.217.0/path/mod.ts";
import * as log from "https://deno.land/std@0.217.0/log/mod.ts";
import { Command, program } from "npm:commander@12.0.0";

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
	const sbInfo = sandboxList.find((sb) => sb.id === sandboxId)!;

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
	const resJson = await res.json();
	if (resJson.code === 201) {
		log.info(`Triggered ${operation} on ${sbInfo.hostName}`);
	} else {
		log.error(
			`Failed to ${operation} sandbox ${
				sbInfo?.hostName || sandboxId
			}: ${resJson.code} ${resJson.error.message}`,
		);
	}
}

async function run() {
	function buildSandboxOperationCommand(operation: string) {
		return new Command(operation)
			.argument("<sandbox>", "Sandbox ID or a part of the hostname")
			.action(async function (findStr: string) {
				for (const sb of sandboxList) {
					if (!sb.hostName.includes(findStr) && sb.id !== findStr) continue;

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

	program.parse();

	log.debug(`args: ${program.args}`);
}

run();
