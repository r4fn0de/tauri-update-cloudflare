import { Env } from '../../worker-configuration';

export type Asset = {
    name: string;
    browser_download_url: string;
    /** Present on GitHub API release assets; required for private-repo downloads. */
    id?: number;
};

type Release = {
    tag_name: string;
    assets: Asset[];
    body: string;
    published_at: string;
};

/**
 * Get the latest release from the GitHub API
 * @param request The Worker Request object from the fetch event
 * @param env The Worker environment object
 * @returns Response object from the GitHub API
 */
export async function getReleases(
    request: Request,
    env: Env
): Promise<Response> {
    // build the request headers conditionally
    const headers = new Headers({
        Accept: 'application/vnd.github.preview',
        'User-Agent': request.headers.get('User-Agent') as string
    });

    if (env.GITHUB_API_TOKEN?.length) {
        headers.set('Authorization', `token ${env.GITHUB_API_TOKEN}`);
    }

    return await fetch(
        `https://api.github.com/repos/${env.GITHUB_ACCOUNT}/${env.GITHUB_REPO}/releases/latest`,
        {
            method: 'GET',
            headers
        }
    );
}

/**
 * Get the latest release from the GitHub API as a Release object
 * @param request The Worker Request object from the fetch event
 * @param env The Worker environment object
 * @returns The latest release as a Release object
 */
export async function getLatestRelease(
    request: Request,
    env: Env
): Promise<Release | null> {
    const releases: Response = await getReleases(request, env);
    if (!releases.ok) {
        return null;
    }

    const release = (await releases.json()) as Release;
    if (!release.tag_name || !Array.isArray(release.assets)) {
        return null;
    }

    return release;
}

/**
 * Find the signature file for a given asset
 * @param fileName The name of the file to find the signature for
 * @param assets The assets to search for the signature
 * @returns The signature as a string or undefined if not found
 */
function releaseAssetDownloadUrl(asset: Asset, env: Env): string {
    if (asset.id != null) {
        return `https://api.github.com/repos/${env.GITHUB_ACCOUNT}/${env.GITHUB_REPO}/releases/assets/${asset.id}`;
    }
    return asset.browser_download_url;
}

export async function findAssetSignature(
    fileName: string,
    assets: Asset[],
    env?: Env
): Promise<string | undefined> {
    const sigName = `${fileName}.sig`;
    const foundSignature = assets.find(
        (asset) => asset.name.toLowerCase() === sigName.toLowerCase()
    );

    if (!foundSignature || !env) {
        return undefined;
    }

    const headers = new Headers({
        Accept: 'application/octet-stream',
        'User-Agent': 'cove-updates-worker'
    });

    if (env.GITHUB_API_TOKEN?.length) {
        headers.set('Authorization', `token ${env.GITHUB_API_TOKEN}`);
    }

    const response = await fetch(releaseAssetDownloadUrl(foundSignature, env), {
        method: 'GET',
        headers,
        redirect: 'follow'
    });

    if (!response.ok) {
        return undefined;
    }

    const text = (await response.text()).trim();
    return text.length > 0 ? text : undefined;
}
