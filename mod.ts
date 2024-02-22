import { load } from "https://deno.land/std@0.217.0/dotenv/mod.ts";

const env = await load();
const SF_API_ID = env.SF_API_ID;
const SF_API_SECRET = env.SF_API_SECRET;

function useCachedResult<T>(
	result: T,
	storageKey: string,
	maxDuration: Temporal.Duration,
) {
	const cachedResult = localStorage.getItem(storageKey);
	if (cachedResult) {
		const { value, exp } = JSON.parse(cachedResult) as {value: T, exp: number};
		console.log(`Retrieved ${storageKey} from cache. Exp: ${Temporal.Instant.fromEpochMilliseconds(exp).toString()}`);
		if (Date.now() < exp) return value;
	}
	let instant = Temporal.Now.instant();
	instant = instant.add(maxDuration);
	localStorage.setItem(
		storageKey,
		JSON.stringify({ value: result, exp: instant.epochMilliseconds }),
	);
	console.log(`Cached ${storageKey}. Exp: ${instant.toString()}`);

	return result;
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

const sfccAuthToken = useCachedResult(
	await getSfccAuthToken(),
	"sfccAuthToken",
	Temporal.Duration.from({ minutes: 29, seconds: 55 }),
);
