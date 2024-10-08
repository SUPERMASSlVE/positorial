import Groq from "groq-sdk";
import { headers } from "next/headers";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { unstable_after as after } from "next/server";
import { GoogleAuth } from 'google-auth-library';

const groq = new Groq();

const schema = zfd.formData({
	input: z.union([zfd.text(), zfd.file()]),
	message: zfd.repeatableOfType(
		zfd.json(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string(),
			})
		)
	),
});

export async function POST(request: Request) {
	console.time("transcribe " + request.headers.get("x-vercel-id") || "local");

	const { data, success } = schema.safeParse(await request.formData());
	if (!success) return new Response("Invalid request", { status: 400 });

	const transcript = await getTranscript(data.input);
	if (!transcript) return new Response("Invalid audio", { status: 400 });

	console.timeEnd("transcribe " + request.headers.get("x-vercel-id") || "local");
	console.time("text completion " + request.headers.get("x-vercel-id") || "local");

	const completion = await groq.chat.completions.create({
		model: "llama3-8b-8192",
		messages: [
			{
				role: "system",
				content: `- You are Swift, a friendly and helpful voice assistant.
			- Respond briefly to the user's request, and do not provide unnecessary information.
			- If you don't understand the user's request, ask for clarification.
			- You do not have access to up-to-date information, so you should not provide real-time data.
			- You are not capable of performing actions other than responding to the user.
			- Do not use markdown, emojis, or other formatting in your responses. Respond in a way easily spoken by text-to-speech software.
			- User location is ${location()}.
			- The current time is ${time()}.
			- Your large language model is Llama 3, created by Meta, the 8 billion parameter version. It is hosted on Groq, an AI infrastructure company that builds fast inference technology.
			- Your text-to-speech model is Google Cloud Text-to-Speech.
			- You are built with Next.js and hosted on Vercel.`,
			},
			...data.message,
			{
				role: "user",
				content: transcript,
			},
		],
	});

	const response = completion.choices[0].message.content;
	console.timeEnd("text completion " + request.headers.get("x-vercel-id") || "local");

	console.time("google tts request " + request.headers.get("x-vercel-id") || "local");

	const voice = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
		method: "POST",
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			Authorization: `Bearer ${await getGoogleCloudAccessToken()}`, 
		},
		body: JSON.stringify({
			input: {
				text: response, 
			},
			voice: {
				languageCode: "en-US",
				name: "en-US-Neural2-J", // You can choose other voices here
			},
			audioConfig: {
				audioEncoding: "LINEAR16", 
				sampleRateHertz: 24000,
			},
		}),
	});

	console.timeEnd("google tts request " + request.headers.get("x-vercel-id") || "local");

	if (!voice.ok) {
		console.error(await voice.text());
		return new Response("Voice synthesis failed", { status: 500 });
	}

	const voiceData = await voice.json(); 

	console.time("stream " + request.headers.get("x-vercel-id") || "local");
	after(() => {
		console.timeEnd("stream " + request.headers.get("x-vercel-id") || "local");
	});

	return new Response(Buffer.from(voiceData.audioContent, "base64"), { 
		headers: {
			"X-Transcript": encodeURIComponent(transcript),
			"X-Response": encodeURIComponent(response),
			"Content-Type": "audio/wav", // Google Cloud TTS default format
		},
	});
}

function location() {
	const headersList = headers();

	const country = headersList.get("x-vercel-ip-country");
	const region = headersList.get("x-vercel-ip-country-region");
	const city = headersList.get("x-vercel-ip-city");

	if (!country || !region || !city) return "unknown";

	return `${city}, ${region}, ${country}`;
}

function time() {
	return new Date().toLocaleString("en-US", {
		timeZone: headers().get("x-vercel-ip-timezone") || undefined,
	});
}

async function getTranscript(input: string | File) {
	if (typeof input === "string") return input;

	try {
		const { text } = await groq.audio.transcriptions.create({
			file: input,
			model: "whisper-large-v3",
		});

		return text.trim() || null;
	} catch {
		return null; // Empty audio file
	}
}

async function getGoogleCloudAccessToken() {
    const auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform', // Required scopes
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS // Set to the path to your keyfile.json
    });
    const client = await auth.getClient();
    const accessToken = (await client.getAccessToken()).token;
    return accessToken;
}
