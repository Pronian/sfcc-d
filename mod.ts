import { load } from "https://deno.land/std@0.217.0/dotenv/mod.ts";
import { parseArgs } from "https://deno.land/std@0.217.0/cli/parse_args.ts";

const env = await load();
const SF_API_ID = env.SF_API_ID;
const SF_API_SECRET = env.SF_API_SECRET;

const args = parseArgs(Deno.args);
const verbose = args.v || args.verbose;

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
		verbose &&
			console.log(
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
	verbose && console.log(`Cached ${storageKey}. Exp: ${instant.toString()}`);

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
	// console.log({
	// 	res,
	// 	json,
	// 	cookies: res.headers.get("set-cookie"),
	// });
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
				operation
			}),
		},
	);
	const resJson = await res.json();
	if (resJson.code === 201) {
		console.log(`Sandbox ${sbInfo.hostName} ${resJson.data.sandboxState}`);
	} else {
		console.log(`Failed to ${operation} sandbox ${sbInfo?.hostName || sandboxId}: ${resJson.code} ${resJson.error.message}`);
	}
}

async function run() {
	await updateToken();

	verbose && console.log('args', args);

	if (args._.includes("list")) {
		await updateSandboxList(true);

		const sandboxInfoLine = sandboxList.map((sb) =>
			[sb.id, sb.hostName, sb.state].join("|")
		).join("\n");
		console.log(sandboxInfoLine);
		return;
	}

	await updateSandboxList();

	if (
		["start", "stop", "restart"].includes(args._[0].toString()) &&
		typeof args._[1] === "string"
	) {
		const [operation, findStr] = args._;
		for (const sb of sandboxList) {
			if (!sb.hostName.includes(findStr) && sb.id !== findStr) continue;

			await runSandboxOperation(operation.toString(), sb.id);
		}
		return;
	}
}

run();
