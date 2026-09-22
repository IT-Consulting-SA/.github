import fs from "node:fs/promises";

const ORGANIZATION = "IT-Consulting-SA";

const OUTPUT_SVG = "profile/contributors.svg";
const README_FILE = "profile/README.md";

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
 * Number of contributors displayed in the README.
 *
 * The complete contributor list is still collected.
 */
const MAX_DISPLAYED = 60;

/**
 * Number of contributors per row in README.
 */
const README_COLUMNS = 8;

/**
 * Pause execution.
 */
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub API request with retries.
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
     * GitHub rate limit.
     */
    if (
      response.status === 403 ||
      response.status === 429
    ) {
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
      `${url}${separator}` +
      `per_page=${PER_PAGE}&page=${page}`;

    const data =
      await githubFetch(pageUrl);

    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {
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
        results[currentIndex] =
          await worker(
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
 * IMPORTANT:
 * .github is intentionally included.
 *
 * New repositories created in the organization
 * will automatically be discovered on the next run.
 */
async function getRepositories() {
  console.log(
    `Fetching repositories from ${ORGANIZATION}...`
  );

  const repositories =
    await fetchAllPages(
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
 * GitHub login = unique identifier.
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
   * Ignore GitHub bots.
   *
   * DO NOT use:
   *
   * login.toLowerCase().includes("bot")
   *
   * because a legitimate GitHub username
   * may contain the word "bot".
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

  /**
   * IMPORTANT:
   *
   * Always build the contributor profile URL
   * directly from the GitHub login.
   *
   * This prevents accidentally storing the
   * organization URL.
   */
  const htmlUrl =
    `https://github.com/${encodeURIComponent(
      login
    )}`;

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

  if (
    !contributor.avatarUrl &&
    avatarUrl
  ) {
    contributor.avatarUrl =
      avatarUrl;
  }
}

/**
 * Get commit contributors.
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
 * Get pull requests.
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
 * Get pull request reviews.
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
 * Collect all contributors.
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
        `  → pull requests: ${repository.full_name}`
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
 * Escape HTML.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Escape XML.
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
 * Get initials.
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
 * Download avatar and convert to Base64.
 *
 * Used only for the SVG fallback.
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

    const safeContentType =
      contentType.startsWith("image/")
        ? contentType
        : "image/jpeg";

    return (
      `data:${safeContentType};base64,` +
      buffer.toString("base64")
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
 * Generate SVG fallback.
 *
 * IMPORTANT:
 * Individual SVG links are NOT relied upon
 * by the README because the SVG is loaded as
 * an <img>.
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

  const displayed =
    sorted.slice(
      0,
      MAX_DISPLAYED
    );

  const avatarSize = 72;
  const gap = 28;
  const columns = 8;
  const cellHeight = 112;

  const rows =
    Math.max(
      1,
      Math.ceil(
        displayed.length /
          columns
      )
    );

  const width =
    columns * avatarSize +
    (columns - 1) * gap +
    40;

  const height =
    rows * cellHeight +
    40;

  const elements = [];

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

    const initials =
      escapeXml(
        getInitials(
          contributor.login
        )
      );

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
      `);
    } else {
      elements.push(`
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
    fill="#ffffff"
  />

  ${elements.join("\n")}

</svg>
`;
}

/**
 * Generate the INTERACTIVE contributor grid
 * directly inside README.md.
 *
 * Every contributor gets his own <a href="">
 * pointing to his own GitHub profile.
 *
 * No outer organization link is used.
 */
function generateReadmeGrid(
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

  const displayed =
    sorted.slice(
      0,
      MAX_DISPLAYED
    );

  if (displayed.length === 0) {
    return `
<div align="center">

_Aucun contributeur à afficher pour le moment._

</div>
`;
  }

  const rows = [];

  for (
    let i = 0;
    i < displayed.length;
    i += README_COLUMNS
  ) {
    const row =
      displayed.slice(
        i,
        i + README_COLUMNS
      );

    const cells = row.map(
      (contributor) => {
        const login =
          escapeHtml(
            contributor.login
          );

        const profileUrl =
          escapeHtml(
            contributor.htmlUrl
          );

        const avatarUrl =
          escapeHtml(
            contributor.avatarUrl
          );

        const repoCount =
          contributor.repositories.size;

        return `
<td align="center" valign="top" width="12.5%">

<a href="${profileUrl}" title="Voir le profil GitHub de ${login}">

<img
  src="${avatarUrl}"
  alt="${login}"
  width="72"
  height="72"
/>

<br />

<strong>${login}</strong>

</a>

<br />

<sub>${repoCount} repo${repoCount > 1 ? "s" : ""}</sub>

</td>
`;
      }
    );

    /**
     * Fill remaining cells so the table remains
     * visually aligned.
     */
    while (
      cells.length <
      README_COLUMNS
    ) {
      cells.push(
        `
<td width="12.5%"></td>
`
      );
    }

    rows.push(`
<tr>
${cells.join("\n")}
</tr>
`);
  }

  return `
<div align="center">

<table>
${rows.join("\n")}
</table>

<sub>
Affichage des ${displayed.length} contributeurs les plus actifs.
</sub>

</div>
`;
}

/**
 * Update the Contributors section in README.md.
 *
 * The section must contain:
 *
 * <!-- CONTRIBUTORS:START -->
 * ...
 * <!-- CONTRIBUTORS:END -->
 */
async function updateReadme(
  contributors
) {
  console.log(
    "Updating contributors section in README..."
  );

  let readme;

  try {
    readme =
      await fs.readFile(
        README_FILE,
        "utf8"
      );
  } catch (error) {
    throw new Error(
      `Unable to read ${README_FILE}: ${error.message}`
    );
  }

  const startMarker =
    "<!-- CONTRIBUTORS:START -->";

  const endMarker =
    "<!-- CONTRIBUTORS:END -->";

  const startIndex =
    readme.indexOf(
      startMarker
    );

  const endIndex =
    readme.indexOf(
      endMarker
    );

  if (
    startIndex === -1 ||
    endIndex === -1
  ) {
    throw new Error(
      `Contributor markers not found in ${README_FILE}.\n\n` +
      `Add these two markers around the contributor grid:\n\n` +
      `${startMarker}\n` +
      `${endMarker}`
    );
  }

  if (endIndex < startIndex) {
    throw new Error(
      "Invalid contributor markers order in README."
    );
  }

  const grid =
    generateReadmeGrid(
      contributors
    );

  const before =
    readme.slice(
      0,
      startIndex +
        startMarker.length
    );

  const after =
    readme.slice(
      endIndex
    );

  const updated =
    `${before}\n\n` +
    `${grid}\n` +
    `${after}`;

  await fs.writeFile(
    README_FILE,
    updated,
    "utf8"
  );

  console.log(
    `Updated ${README_FILE}`
  );
}

/**
 * Main.
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
   * LOG CONTRIBUTORS
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
      ` — ${contributor.repositories.size} repo(s)` +
      ` — ${contributor.htmlUrl}`
    );
  }

  /*
   * ------------------------------------------------------------
   * GENERATE SVG FALLBACK
   * ------------------------------------------------------------
   */

  console.log("");
  console.log(
    "Generating SVG fallback..."
  );

  const svg =
    await generateSvg(
      contributors
    );

  await fs.mkdir(
    "profile",
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    OUTPUT_SVG,
    svg,
    "utf8"
  );

  console.log(
    `Generated ${OUTPUT_SVG}`
  );

  /*
   * ------------------------------------------------------------
   * UPDATE README
   * ------------------------------------------------------------
   */

  await updateReadme(
    contributors
  );

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    " Contributors generation completed"
  );
  console.log(
    "=========================================="
  );
  console.log("");
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
