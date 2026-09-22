import fs from "node:fs/promises";

const ORGANIZATION = "IT-Consulting-SA";
const OUTPUT_FILE = "profile/contributors.svg";

const API_BASE = "https://api.github.com";

const TOKEN =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  "";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "IT-Consulting-Contributors-Bot",
  ...(TOKEN
    ? {
        Authorization: `Bearer ${TOKEN}`,
      }
    : {}),
};

const PER_PAGE = 100;
const MAX_CONCURRENT_REQUESTS = 5;

/**
 * Pause execution for a given number of milliseconds.
 */
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform a GitHub API request with retries.
 */
async function githubFetch(url) {
  let response;

  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, {
      headers: HEADERS,
    });

    if (response.ok) {
      return response.json();
    }

    /**
     * GitHub rate limiting.
     */
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(
        response.headers.get("retry-after")
      );

      if (retryAfter) {
        await sleep(retryAfter * 1000);
      } else {
        await sleep(attempt * 3000);
      }

      continue;
    }

    const body = await response.text();

    throw new Error(
      `GitHub API error ${response.status}: ${url}\n${body}`
    );
  }

  throw new Error(
    `GitHub API request failed after retries: ${url}`
  );
}

/**
 * Fetch all pages from a GitHub API endpoint.
 */
async function fetchAllPages(url) {
  const results = [];

  for (let page = 1; ; page++) {
    const separator = url.includes("?")
      ? "&"
      : "?";

    const pageUrl =
      `${url}${separator}per_page=${PER_PAGE}&page=${page}`;

    const data = await githubFetch(pageUrl);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    results.push(...data);

    if (data.length < PER_PAGE) {
      break;
    }
  }

  return results;
}

/**
 * Execute async tasks with limited concurrency.
 */
async function mapWithConcurrency(
  items,
  worker,
  concurrency
) {
  const results = [];

  let index = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = index++;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = await worker(
          items[currentIndex],
          currentIndex
        );
      } catch (error) {
        console.error(
          `Failed processing item ${currentIndex}:`,
          error.message
        );

        results[currentIndex] = null;
      }
    }
  }

  const workers = Array.from(
    {
      length: Math.min(
        concurrency,
        items.length
      ),
    },
    () => runWorker()
  );

  await Promise.all(workers);

  return results;
}

/**
 * Get all repositories belonging to the organization.
 *
 * Repositories created in the future are automatically
 * discovered during the next workflow execution.
 *
 * Archived and disabled repositories are ignored.
 *
 * IMPORTANT:
 * .github is NOT excluded.
 */
async function getRepositories() {
  console.log(
    `Fetching repositories from ${ORGANIZATION}...`
  );

  const repositories = await fetchAllPages(
    `${API_BASE}/orgs/${ORGANIZATION}/repos?type=all`
  );

  return repositories.filter(
    (repo) =>
      !repo.archived &&
      !repo.disabled
  );
}

/**
 * Add a GitHub user to the global contributor map.
 *
 * The GitHub login is used as the unique identifier.
 */
function addContributor(
  map,
  user,
  source
) {
  if (!user) {
    return;
  }

  const login =
    user.login ||
    user.user?.login;

  if (!login) {
    return;
  }

  const type =
    user.type ||
    user.user?.type;

  /**
   * Ignore GitHub bots and GitHub Apps.
   *
   * We deliberately DO NOT use:
   *
   * login.toLowerCase().includes("bot")
   *
   * because legitimate usernames may contain "bot".
   */
  if (
    type === "Bot" ||
    login.endsWith("[bot]")
  ) {
    return;
  }

  const avatarUrl =
    user.avatar_url ||
    user.user?.avatar_url ||
    "";

  const htmlUrl =
    user.html_url ||
    user.user?.html_url ||
    `https://github.com/${login}`;

  if (!map.has(login)) {
    map.set(login, {
      login,
      avatarUrl,
      htmlUrl,
      contributions: 0,
      repositories: new Set(),
      sources: new Set(),
    });
  }

  const contributor =
    map.get(login);

  contributor.contributions += 1;

  contributor.repositories.add(
    source.repository
  );

  contributor.sources.add(
    source.type
  );

  /**
   * If the contributor was first discovered
   * from an endpoint without an avatar URL,
   * update it when one becomes available.
   */
  if (
    !contributor.avatarUrl &&
    avatarUrl
  ) {
    contributor.avatarUrl = avatarUrl;
  }

  if (
    !contributor.htmlUrl &&
    htmlUrl
  ) {
    contributor.htmlUrl = htmlUrl;
  }
}

/**
 * Fetch classic commit contributors.
 */
async function getCommitContributors(
  repository
) {
  const url =
    `${API_BASE}/repos/` +
    `${repository.full_name}/contributors`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch contributors for ` +
      `${repository.full_name}:`,
      error.message
    );

    return [];
  }
}

/**
 * Fetch pull requests.
 */
async function getPullRequests(
  repository
) {
  const url =
    `${API_BASE}/repos/` +
    `${repository.full_name}/pulls?state=all`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch PRs for ` +
      `${repository.full_name}:`,
      error.message
    );

    return [];
  }
}

/**
 * Fetch reviews for a pull request.
 */
async function getPullRequestReviews(
  repository,
  pullRequest
) {
  const url =
    `${API_BASE}/repos/` +
    `${repository.full_name}` +
    `/pulls/${pullRequest.number}/reviews`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch reviews for ` +
      `${repository.full_name}` +
      `#${pullRequest.number}:`,
      error.message
    );

    return [];
  }
}

/**
 * Collect contributors from:
 *
 * - commits
 * - pull requests
 * - pull request reviews
 */
async function collectContributors(
  repositories
) {
  const contributors = new Map();

  console.log(
    `Processing ${repositories.length} repositories...`
  );

  /*
   * ------------------------------------------------------------
   * COMMITS
   * ------------------------------------------------------------
   */

  await mapWithConcurrency(
    repositories,
    async (repository) => {
      console.log(
        `  → commits: ${repository.full_name}`
      );

      const users =
        await getCommitContributors(
          repository
        );

      for (const user of users) {
        addContributor(
          contributors,
          user,
          {
            repository:
              repository.name,
            type: "commit",
          }
        );
      }
    },
    MAX_CONCURRENT_REQUESTS
  );

  /*
   * ------------------------------------------------------------
   * PULL REQUESTS
   * ------------------------------------------------------------
   */

  const pullRequests = [];

  await mapWithConcurrency(
    repositories,
    async (repository) => {
      console.log(
        `  → pull requests: ` +
        `${repository.full_name}`
      );

      const prs =
        await getPullRequests(
          repository
        );

      for (const pullRequest of prs) {
        pullRequests.push({
          repository,
          pullRequest,
        });

        /**
         * PR author.
         */
        addContributor(
          contributors,
          pullRequest.user,
          {
            repository:
              repository.name,
            type: "pull-request",
          }
        );
      }
    },
    MAX_CONCURRENT_REQUESTS
  );

  /*
   * ------------------------------------------------------------
   * REVIEWS
   * ------------------------------------------------------------
   */

  await mapWithConcurrency(
    pullRequests,
    async ({
      repository,
      pullRequest,
    }) => {
      const reviews =
        await getPullRequestReviews(
          repository,
          pullRequest
        );

      for (const review of reviews) {
        addContributor(
          contributors,
          review.user,
          {
            repository:
              repository.name,
            type: "review",
          }
        );
      }
    },
    MAX_CONCURRENT_REQUESTS
  );

  return contributors;
}

/**
 * Escape XML/SVG content.
 */
function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Get initials from a GitHub username.
 */
function getInitials(login) {
  if (!login) {
    return "?";
  }

  const cleaned =
    login.replace(
      /[^a-zA-Z0-9]/g,
      " "
    );

  const parts =
    cleaned
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (parts.length >= 2) {
    return (
      parts[0][0] +
      parts[1][0]
    ).toUpperCase();
  }

  return login
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Download a GitHub avatar and convert it
 * into a Base64 data URI.
 *
 * This avoids relying on an external image URL
 * from inside the SVG.
 */
async function downloadAvatar(
  avatarUrl
) {
  if (!avatarUrl) {
    return null;
  }

  try {
    const separator =
      avatarUrl.includes("?")
        ? "&"
        : "?";

    const url =
      `${avatarUrl}${separator}s=128`;

    const response =
      await fetch(url, {
        headers: {
          "User-Agent":
            "IT-Consulting-Contributors-Bot",
          Accept: "image/*",
        },
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (!buffer.length) {
      throw new Error(
        "Empty avatar response"
      );
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "image/jpeg";

    /**
     * Only allow actual image content types.
     */
    const safeContentType =
      contentType.startsWith("image/")
        ? contentType
        : "image/jpeg";

    const base64 =
      buffer.toString("base64");

    return (
      `data:${safeContentType};base64,${base64}`
    );
  } catch (error) {
    console.warn(
      `Could not download avatar: ${avatarUrl}`,
      error.message
    );

    return null;
  }
}

/**
 * Generate the contributors SVG.
 *
 * Avatars are embedded directly into the SVG
 * as Base64 data URIs.
 */
async function generateSvg(
  contributors
) {
  const sorted =
    [...contributors.values()]
      .sort(
        (a, b) =>
          b.repositories.size -
            a.repositories.size ||
          b.contributions -
            a.contributions ||
          a.login.localeCompare(
            b.login
          )
      );

  /**
   * Limit the visual output.
   *
   * The complete contributor list is still
   * collected and deduplicated.
   */
  const MAX_DISPLAYED = 60;

  const displayed =
    sorted.slice(
      0,
      MAX_DISPLAYED
    );

  const avatarSize = 72;
  const gap = 28;
  const columns = 8;

  const rows =
    Math.max(
      1,
      Math.ceil(
        displayed.length /
          columns
      )
    );

  const cellHeight = 112;

  const width =
    columns * avatarSize +
    (columns - 1) * gap +
    40;

  const height =
    rows * cellHeight +
    40;

  const elements = [];

  /*
   * ------------------------------------------------------------
   * AVATARS
   * ------------------------------------------------------------
   */

  for (
    let index = 0;
    index < displayed.length;
    index++
  ) {
    const contributor =
      displayed[index];

    const column =
      index % columns;

    const row =
      Math.floor(
        index / columns
      );

    const x =
      20 +
      column *
        (avatarSize + gap);

    const y =
      20 +
      row *
        cellHeight;

    const login =
      escapeXml(
        contributor.login
      );

    const profileUrl =
      escapeXml(
        contributor.htmlUrl
      );

    const initials =
      escapeXml(
        getInitials(
          contributor.login
        )
      );

    /**
     * Each avatar gets its own clipPath ID.
     */
    const clipId =
      `avatar-clip-${index}`;

    const avatarData =
      await downloadAvatar(
        contributor.avatarUrl
      );

    if (avatarData) {
      elements.push(`
        <defs>
          <clipPath id="${clipId}">
            <circle
              cx="${x + avatarSize / 2}"
              cy="${y + avatarSize / 2}"
              r="${avatarSize / 2}"
            />
          </clipPath>
        </defs>

        <a
          href="${profileUrl}"
          target="_blank"
        >
          <title>
            ${login} — ${contributor.repositories.size} repo(s)
          </title>

          <image
            x="${x}"
            y="${y}"
            width="${avatarSize}"
            height="${avatarSize}"
            href="${avatarData}"
            clip-path="url(#${clipId})"
            preserveAspectRatio="xMidYMid slice"
          />

          <text
            x="${x + avatarSize / 2}"
            y="${y + avatarSize + 22}"
            text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif"
            font-size="12"
            font-weight="600"
            fill="#24292f"
          >
            ${login}
          </text>
        </a>
      `);
    } else {
      /**
       * Fallback if the avatar cannot be downloaded.
       */
      elements.push(`
        <a
          href="${profileUrl}"
          target="_blank"
        >
          <title>
            ${login} — ${contributor.repositories.size} repo(s)
          </title>

          <circle
            cx="${x + avatarSize / 2}"
            cy="${y + avatarSize / 2}"
            r="${avatarSize / 2}"
            fill="#24292f"
          />

          <text
            x="${x + avatarSize / 2}"
            y="${y + avatarSize / 2 + 8}"
            text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif"
            font-size="22"
            font-weight="700"
            fill="#ffffff"
          >
            ${initials}
          </text>

          <text
            x="${x + avatarSize / 2}"
            y="${y + avatarSize + 22}"
            text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif"
            font-size="12"
            font-weight="600"
            fill="#24292f"
          >
            ${login}
          </text>
        </a>
      `);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${width}"
  height="${height}"
  viewBox="0 0 ${width} ${height}"
  role="img"
  aria-label="IT-Consulting contributors"
>

  <title>
    IT-Consulting Contributors
  </title>

  <rect
    width="100%"
    height="100%"
    fill="transparent"
  />

  ${elements.join("\n")}

</svg>
`;
}

/**
 * Main execution.
 */
async function main() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    " IT-Consulting Contributors Generator"
  );
  console.log(
    "=========================================="
  );
  console.log("");

  /*
   * ------------------------------------------------------------
   * REPOSITORIES
   * ------------------------------------------------------------
   */

  const repositories =
    await getRepositories();

  console.log(
    `Found ${repositories.length} repositories.`
  );

  if (
    repositories.length === 0
  ) {
    console.log(
      "No repositories found."
    );

    return;
  }

  /*
   * ------------------------------------------------------------
   * CONTRIBUTORS
   * ------------------------------------------------------------
   */

  const contributors =
    await collectContributors(
      repositories
    );

  console.log("");

  console.log(
    `Unique contributors: ${contributors.size}`
  );

  /*
   * ------------------------------------------------------------
   * DISPLAY CONTRIBUTORS IN LOGS
   * ------------------------------------------------------------
   */

  const sorted =
    [...contributors.values()]
      .sort(
        (a, b) =>
          b.repositories.size -
            a.repositories.size ||
          b.contributions -
            a.contributions ||
          a.login.localeCompare(
            b.login
          )
      );

  for (
    const contributor of sorted
  ) {
    console.log(
      `  ${contributor.login}` +
      ` — ${contributor.repositories.size} repo(s)`
    );
  }

  /*
   * ------------------------------------------------------------
   * GENERATE SVG
   * ------------------------------------------------------------
   */

  console.log("");
  console.log(
    "Generating contributors SVG..."
  );

  const svg =
    await generateSvg(
      contributors
    );

  /*
   * ------------------------------------------------------------
   * CREATE OUTPUT DIRECTORY
   * ------------------------------------------------------------
   */

  await fs.mkdir(
    "profile",
    {
      recursive: true,
    }
  );

  /*
   * ------------------------------------------------------------
   * WRITE FILE
   * ------------------------------------------------------------
   */

  await fs.writeFile(
    OUTPUT_FILE,
    svg,
    "utf8"
  );

  console.log("");
  console.log(
    `Generated ${OUTPUT_FILE}`
  );

  console.log("");
  console.log("Done.");
}

/**
 * Global error handler.
 */
main().catch((error) => {
  console.error("");
  console.error(
    "Generation failed:"
  );
  console.error(error);

  process.exit(1);
});
