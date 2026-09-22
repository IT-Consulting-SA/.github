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
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const PER_PAGE = 100;
const MAX_CONCURRENT_REQUESTS = 5;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function githubFetch(url) {
  let response;

  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, {
      headers: HEADERS,
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));

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

async function fetchAllPages(url) {
  const results = [];

  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";

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

async function mapWithConcurrency(items, worker, concurrency) {
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
      length: Math.min(concurrency, items.length),
    },
    () => runWorker()
  );

  await Promise.all(workers);

  return results;
}

/**
 * Get all repositories belonging to the organization.
 *
 * This means repositories created in the future are automatically
 * discovered during the next workflow execution.
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
 * The login is the deduplication key.
 */
function addContributor(map, user, source) {
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

  // Ignore GitHub Apps / bots.
  if (
    type === "Bot" ||
    login.endsWith("[bot]") ||
    login.toLowerCase().includes("bot")
  ) {
    return;
  }

  const avatarUrl =
    user.avatar_url ||
    user.user?.avatar_url;

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

  const contributor = map.get(login);

  contributor.contributions += 1;
  contributor.repositories.add(source.repository);
  contributor.sources.add(source.type);
}

/**
 * Fetch classic commit contributors.
 */
async function getCommitContributors(repository) {
  const url =
    `${API_BASE}/repos/${repository.full_name}/contributors`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch contributors for ${repository.full_name}:`,
      error.message
    );

    return [];
  }
}

/**
 * Fetch pull requests.
 */
async function getPullRequests(repository) {
  const url =
    `${API_BASE}/repos/${repository.full_name}/pulls?state=all`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch PRs for ${repository.full_name}:`,
      error.message
    );

    return [];
  }
}

/**
 * Fetch reviews for a pull request.
 */
async function getPullRequestReviews(repository, pullRequest) {
  const url =
    `${API_BASE}/repos/${repository.full_name}` +
    `/pulls/${pullRequest.number}/reviews`;

  try {
    return await fetchAllPages(url);
  } catch (error) {
    console.warn(
      `Could not fetch reviews for ${repository.full_name}` +
      `#${pullRequest.number}:`,
      error.message
    );

    return [];
  }
}

async function collectContributors(repositories) {
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
        await getCommitContributors(repository);

      for (const user of users) {
        addContributor(
          contributors,
          user,
          {
            repository: repository.name,
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
        `  → pull requests: ${repository.full_name}`
      );

      const prs =
        await getPullRequests(repository);

      for (const pullRequest of prs) {
        pullRequests.push({
          repository,
          pullRequest,
        });

        /*
         * PR author
         */
        addContributor(
          contributors,
          pullRequest.user,
          {
            repository: repository.name,
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
    async ({ repository, pullRequest }) => {
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
            repository: repository.name,
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
 * Escape SVG XML content.
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
 * Generate the contributors SVG.
 */
function generateSvg(contributors) {
  const sorted = [...contributors.values()]
    .sort(
      (a, b) =>
        b.repositories.size - a.repositories.size ||
        b.contributions - a.contributions ||
        a.login.localeCompare(b.login)
    );

  /*
   * Limit the visual output to avoid an enormous SVG.
   *
   * The complete contributor set is still computed.
   */
  const MAX_DISPLAYED = 60;

  const displayed =
    sorted.slice(0, MAX_DISPLAYED);

  const avatarSize = 64;
  const gap = 20;
  const columns = 8;
  const rows = Math.ceil(
    displayed.length / columns
  );

  const width =
    columns * avatarSize +
    (columns - 1) * gap +
    40;

  const height =
    rows * 100 +
    (rows - 1) * 20 +
    40;

  const avatars = displayed
    .map((contributor, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);

      const x =
        20 +
        column * (avatarSize + gap);

      const y =
        20 +
        row * 100;

      const login =
        escapeXml(contributor.login);

      const profileUrl =
        escapeXml(contributor.htmlUrl);

      const avatarUrl =
        escapeXml(contributor.avatarUrl);

      return `
        <a
          href="${profileUrl}"
          target="_blank"
          rel="noopener noreferrer"
        >
          <title>
            ${login} — ${contributor.repositories.size} repo(s)
          </title>

          <image
            x="${x}"
            y="${y}"
            width="${avatarSize}"
            height="${avatarSize}"
            href="${avatarUrl}"
            preserveAspectRatio="xMidYMid slice"
          />

          <text
            x="${x + avatarSize / 2}"
            y="${y + 82}"
            text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif"
            font-size="12"
            fill="#24292f"
          >
            ${login}
          </text>
        </a>
      `;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${width}"
  height="${height}"
  viewBox="0 0 ${width} ${height}"
  role="img"
  aria-label="IT-Consulting contributors"
>
  <title>IT-Consulting Contributors</title>

  <rect
    width="100%"
    height="100%"
    fill="transparent"
  />

  ${avatars}
</svg>
`;
}

async function main() {
  console.log("");
  console.log("==========================================");
  console.log(" IT-Consulting Contributors Generator");
  console.log("==========================================");
  console.log("");

  const repositories =
    await getRepositories();

  console.log(
    `Found ${repositories.length} repositories.`
  );

  if (repositories.length === 0) {
    console.log(
      "No repositories found."
    );

    return;
  }

  const contributors =
    await collectContributors(
      repositories
    );

  console.log("");
  console.log(
    `Unique contributors: ${contributors.size}`
  );

  const sorted =
    [...contributors.values()].sort(
      (a, b) =>
        b.repositories.size -
        a.repositories.size
    );

  for (const contributor of sorted) {
    console.log(
      `  ${contributor.login}` +
      ` — ${contributor.repositories.size} repo(s)`
    );
  }

  const svg =
    generateSvg(contributors);

  await fs.mkdir(
    "profile",
    { recursive: true }
  );

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

main().catch((error) => {
  console.error("");
  console.error("Generation failed:");
  console.error(error);

  process.exit(1);
});
