import fs from "fs/promises";

const ORGANIZATION = "IT-Consulting-SA";
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

const START_MARKER = "<!-- CONTRIBUTORS:START -->";
const END_MARKER = "<!-- CONTRIBUTORS:END -->";

const COLUMNS = 8;


/* ============================================================
   GitHub API
============================================================ */

async function githubFetch(url) {
  const response = await fetch(url, {
    headers: HEADERS,
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `GitHub API error ${response.status}: ${url}\n${body}`
    );
  }

  return response.json();
}


async function fetchAllPages(url) {
  const results = [];

  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";

    const data = await githubFetch(
      `${url}${separator}per_page=100&page=${page}`
    );

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    results.push(...data);

    if (data.length < 100) {
      break;
    }
  }

  return results;
}


/* ============================================================
   Helpers
============================================================ */

function isBot(user) {
  if (!user) return true;

  const login = user.login || "";

  return (
    user.type === "Bot" ||
    login.endsWith("[bot]")
  );
}


function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* ============================================================
   Contributors
============================================================ */

const contributors = new Map();


function addContributor(user, repository, contribution = 0) {
  if (!user || !user.login) {
    return;
  }

  if (isBot(user)) {
    return;
  }

  const login = user.login;

  if (!contributors.has(login)) {
    contributors.set(login, {
      login,
      avatarUrl:
        user.avatar_url ||
        `https://github.com/${encodeURIComponent(login)}.png?size=96`,
      htmlUrl:
        `https://github.com/${encodeURIComponent(login)}`,
      repositories: new Set(),
      contributions: 0,
    });
  }

  const contributor = contributors.get(login);

  if (repository) {
    contributor.repositories.add(repository);
  }

  contributor.contributions += Number(contribution) || 0;
}


/* ============================================================
   Repositories
============================================================ */

async function getRepositories() {
  const repositories = await fetchAllPages(
    `${API_BASE}/orgs/${ORGANIZATION}/repos?type=all`
  );

  return repositories.filter((repo) => {
    return !repo.archived && !repo.disabled;
  });
}


/* ============================================================
   Commit contributors
============================================================ */

async function collectCommitContributors(repository) {
  const url =
    `${API_BASE}/repos/${ORGANIZATION}/${repository.name}/contributors`;

  try {
    const users = await fetchAllPages(url);

    for (const user of users) {
      addContributor(
        user,
        repository.name,
        user.contributions || 0
      );
    }
  } catch (error) {
    console.warn(
      `Could not get contributors for ${repository.name}:`,
      error.message
    );
  }
}


/* ============================================================
   Pull Requests
============================================================ */

async function collectPullRequests(repository) {
  const url =
    `${API_BASE}/repos/${ORGANIZATION}/${repository.name}/pulls?state=all`;

  try {
    const pullRequests = await fetchAllPages(url);

    for (const pullRequest of pullRequests) {
      if (pullRequest.user) {
        addContributor(
          pullRequest.user,
          repository.name,
          1
        );
      }

      await collectReviews(
        repository.name,
        pullRequest.number
      );
    }
  } catch (error) {
    console.warn(
      `Could not get PRs for ${repository.name}:`,
      error.message
    );
  }
}


/* ============================================================
   Reviews
============================================================ */

async function collectReviews(repositoryName, pullNumber) {
  const url =
    `${API_BASE}/repos/${ORGANIZATION}/${repositoryName}/pulls/${pullNumber}/reviews`;

  try {
    const reviews = await fetchAllPages(url);

    for (const review of reviews) {
      if (!review.user) {
        continue;
      }

      addContributor(
        review.user,
        repositoryName,
        1
      );
    }
  } catch (error) {
    console.warn(
      `Could not get reviews for ${repositoryName} PR #${pullNumber}:`,
      error.message
    );
  }
}


/* ============================================================
   Concurrency
============================================================ */

async function mapWithConcurrency(
  items,
  limit,
  callback
) {
  const results = [];
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] =
        await callback(items[currentIndex]);
    }
  }

  const workers = Array.from(
    {
      length: Math.min(limit, items.length),
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}


/* ============================================================
   Generate contributor item
============================================================ */

function contributorHtml(contributor) {
  const login = escapeHtml(contributor.login);
  const avatarUrl = escapeHtml(contributor.avatarUrl);
  const htmlUrl = escapeHtml(contributor.htmlUrl);

  return `
<a href="${htmlUrl}" title="${login}">
  <img
    src="${avatarUrl}"
    width="72"
    height="72"
    alt="${login}"
  />
  <br>
  <sub><b>${login}</b></sub>
</a>`;
}


/* ============================================================
   Generate clean contributor grid
============================================================ */

function generateContributorsHtml() {
  const list = Array.from(contributors.values());

  list.sort((a, b) => {
    if (b.repositories.size !== a.repositories.size) {
      return b.repositories.size - a.repositories.size;
    }

    if (b.contributions !== a.contributions) {
      return b.contributions - a.contributions;
    }

    return a.login.localeCompare(b.login);
  });

  const rows = [];

  for (let i = 0; i < list.length; i += COLUMNS) {
    const row = list.slice(i, i + COLUMNS);

    const contributorsInRow = row
      .map((contributor) => {
        return `
        ${contributorHtml(contributor)}
        &nbsp;&nbsp;&nbsp;&nbsp;`;
      })
      .join("");

    rows.push(`
<div align="center">

${contributorsInRow}

</div>
`);
  }

  return rows.join("\n");
}


/* ============================================================
   Update README
============================================================ */

async function updateReadme() {
  const readme = await fs.readFile(
    README_FILE,
    "utf8"
  );

  const startIndex =
    readme.indexOf(START_MARKER);

  const endIndex =
    readme.indexOf(END_MARKER);

  if (startIndex === -1) {
    throw new Error(
      `Missing ${START_MARKER} in ${README_FILE}`
    );
  }

  if (endIndex === -1) {
    throw new Error(
      `Missing ${END_MARKER} in ${README_FILE}`
    );
  }

  if (endIndex < startIndex) {
    throw new Error(
      "Invalid contributor markers order."
    );
  }

  const generated =
    generateContributorsHtml();

  const before =
    readme.slice(
      0,
      startIndex + START_MARKER.length
    );

  const after =
    readme.slice(endIndex);

  const updated =
    `${before}\n\n${generated}\n${after}`;

  if (updated !== readme) {
    await fs.writeFile(
      README_FILE,
      updated,
      "utf8"
    );

    console.log(
      `README updated with ${contributors.size} contributors.`
    );
  } else {
    console.log(
      "README already up to date."
    );
  }
}


/* ============================================================
   Main
============================================================ */

async function main() {
  console.log(
    `Discovering repositories for ${ORGANIZATION}...`
  );

  const repositories =
    await getRepositories();

  console.log(
    `Found ${repositories.length} repositories.`
  );

  /*
   * IMPORTANT:
   * .github is intentionally NOT excluded.
   */

  await mapWithConcurrency(
    repositories,
    4,
    async (repository) => {
      console.log(
        `Processing ${repository.name}...`
      );

      await collectCommitContributors(
        repository
      );

      await collectPullRequests(
        repository
      );
    }
  );

  console.log(
    `Found ${contributors.size} unique contributors.`
  );

  await updateReadme();

  console.log(
    "Contributor generation completed successfully."
  );
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});
