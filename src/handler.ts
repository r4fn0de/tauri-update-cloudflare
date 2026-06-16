import { testAsset } from './getPlatform';
import semverValid from 'semver/functions/valid';
import semverGt from 'semver/functions/gt';
import { AVAILABLE_ARCHITECTURES, AVAILABLE_PLATFORMS } from './constants';
import { handleLegacyRequest } from './legacy/handler';
import {
    fetchReleaseAsset,
    findAssetSignature,
    getLatestRelease
} from './services/github';
import { TauriUpdateResponse } from './types';
import { sanitizeVersion } from './utils/versioning';

import { Env } from '../worker-configuration';

const SendJSON = (data: Record<string, unknown>) => {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
};

const responses = {
    NotFound: () => new Response('Not found', { status: 404 }),
    NoContent: () => new Response(null, { status: 204 }),
    SendUpdate: (data: TauriUpdateResponse) => SendJSON(data),
    SendJSON
};

type RequestPathParts = [
    string,
    AVAILABLE_PLATFORMS,
    AVAILABLE_ARCHITECTURES,
    string
];
const handleV1Request = async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
) => {
    const path = new URL(request.url).pathname;
    const [, target, arch, appVersion] = path
        .slice(1)
        .split('/') as RequestPathParts;

    if (!target || !arch || !appVersion || !semverValid(appVersion)) {
        return responses.NotFound();
    }
    const release = await getLatestRelease(request, env);
    if (!release) {
        return responses.NoContent();
    }

    const remoteVersion = sanitizeVersion(release.tag_name.toLowerCase());
    if (!remoteVersion || !semverValid(remoteVersion)) {
        return responses.NotFound();
    }

    const shouldUpdate = semverGt(remoteVersion, appVersion);
    if (!shouldUpdate) {
        return responses.NoContent();
    }

    const match = release.assets.find(({ name }) => {
        const test = testAsset(target, arch, name);

        return test;
    });

    if (typeof match === 'undefined') {
        return responses.NotFound();
    }

    const signature = await findAssetSignature(match.name, release.assets, env);
    if (!signature) {
        console.error(
            `Missing or unreadable signature for ${match.name} (check GITHUB_API_TOKEN and .sig asset)`
        );
        return responses.NotFound();
    }

    const proxy = env.GITHUB_API_TOKEN?.length;
    const downloadURL = proxy
        ? createProxiedFileUrl(request, env, ctx, match.browser_download_url)
        : match.browser_download_url;
    const data: TauriUpdateResponse = {
        url: downloadURL,
        version: remoteVersion,
        notes: release.body,
        pub_date: release.published_at,
        signature
    };

    return responses.SendUpdate(data);
};

const createProxiedFileUrl = (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    downloadURL: string
) => {
    const fileName = downloadURL.split('/')?.at(-1);
    if (!fileName) {
        throw new Error('Could not get file name from download URL');
    }

    const path = new URL(request.url);
    const root = `${path.protocol}//${path.host}`;

    return new URL(`/latest/${fileName}`, root).toString();
};

const getLatestAssets = async (
    request: Request,
    env: Env,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: ExecutionContext
) => {
    const fileName = request.url.split('/')?.at(-1);
    if (!fileName) {
        throw new Error('Could not get file name from download URL');
    }

    const release = await getLatestRelease(request, env);
    if (!release) {
        return responses.NotFound();
    }

    const asset = release.assets.find(({ name }) => name === fileName);
    if (!asset) {
        return responses.NotFound();
    }

    const fileResponse = await fetchReleaseAsset(asset, env);
    if (!fileResponse.ok || !fileResponse.body) {
        console.error(
            `Failed to download ${fileName}: HTTP ${fileResponse.status}`
        );
        return responses.NotFound();
    }

    const headers = new Headers();
    const contentType = fileResponse.headers.get('Content-Type');
    const contentLength = fileResponse.headers.get('Content-Length');
    if (contentType) headers.set('Content-Type', contentType);
    if (contentLength) headers.set('Content-Length', contentLength);

    return new Response(fileResponse.body, {
        status: fileResponse.status,
        headers
    });
};

export async function handleRequest(
    request: Request,
    env: Env,
    ctx: ExecutionContext
): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.includes('/latest')) {
        return getLatestAssets(request, env, ctx);
    }
    const version = path.slice(1).split('/')[0];

    if (version.includes('v')) {
        switch (version) {
            case 'v1':
            default:
                return handleV1Request(request, env, ctx);
        }
    }

    return handleLegacyRequest(request, env);
}
