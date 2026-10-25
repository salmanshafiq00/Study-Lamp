/**
 * Matches a Study Lamp category to a roadmap.sh / developer-roadmap topic.
 *
 * The roadmap data itself is fetched from roadmap.sh's public JSON endpoint
 * (https://roadmap.sh/<slug>.json), which is generated from
 * github.com/nilbuild/developer-roadmap. This module only holds the slug list
 * and the matching rules, so it stays pure and unit-testable.
 */

export interface DeveloperRoadmapTopic {
  slug: string;
  label: string;
  aliases: string[];
}

export const DEVELOPER_ROADMAP_TOPICS: DeveloperRoadmapTopic[] = [
  { slug: "frontend", label: "Frontend Development", aliases: ["frontend", "front end", "web development", "web dev", "client side"] },
  { slug: "frontend-beginner", label: "Frontend Beginner", aliases: ["frontend beginner", "beginner frontend"] },
  { slug: "backend", label: "Backend Development", aliases: ["backend", "back end", "server side", "server side development"] },
  { slug: "backend-beginner", label: "Backend Beginner", aliases: ["backend beginner", "beginner backend"] },
  { slug: "full-stack", label: "Full Stack Development", aliases: ["full stack", "fullstack", "full stack development", "mern", "mean stack"] },
  { slug: "react", label: "React", aliases: ["react", "reactjs", "react js"] },
  { slug: "nextjs", label: "Next.js", aliases: ["nextjs", "next js"] },
  { slug: "vue", label: "Vue", aliases: ["vue", "vuejs", "vue js"] },
  { slug: "angular", label: "Angular", aliases: ["angular", "angularjs", "angular js"] },
  { slug: "javascript", label: "JavaScript", aliases: ["javascript", "js", "ecmascript"] },
  { slug: "typescript", label: "TypeScript", aliases: ["typescript", "ts"] },
  { slug: "html", label: "HTML", aliases: ["html", "html5"] },
  { slug: "css", label: "CSS", aliases: ["css", "css3", "tailwind", "tailwindcss"] },
  { slug: "nodejs", label: "Node.js", aliases: ["nodejs", "node js", "node"] },
  { slug: "python", label: "Python", aliases: ["python", "python3"] },
  { slug: "django", label: "Django", aliases: ["django"] },
  { slug: "java", label: "Java", aliases: ["java"] },
  { slug: "spring-boot", label: "Spring Boot", aliases: ["spring boot", "springboot", "spring"] },
  { slug: "php", label: "PHP", aliases: ["php"] },
  { slug: "laravel", label: "Laravel", aliases: ["laravel"] },
  { slug: "ruby", label: "Ruby", aliases: ["ruby"] },
  { slug: "ruby-on-rails", label: "Ruby on Rails", aliases: ["ruby on rails", "rails"] },
  { slug: "golang", label: "Go", aliases: ["golang", "go language"] },
  { slug: "rust", label: "Rust", aliases: ["rust"] },
  { slug: "c", label: "C", aliases: ["c language", "c programming"] },
  { slug: "cpp", label: "C++", aliases: ["cpp", "c plus plus", "c++"] },
  { slug: "aspnet-core", label: "ASP.NET Core", aliases: ["aspnet", "asp net", "aspnet core", "asp net core", "dotnet", "net core", "csharp", "c sharp"] },
  { slug: "kotlin", label: "Kotlin", aliases: ["kotlin"] },
  { slug: "ios", label: "iOS Development", aliases: ["ios", "ios development", "swift"] },
  { slug: "swift-ui", label: "SwiftUI", aliases: ["swiftui", "swift ui"] },
  { slug: "android", label: "Android Development", aliases: ["android", "android development"] },
  { slug: "flutter", label: "Flutter", aliases: ["flutter", "dart"] },
  { slug: "react-native", label: "React Native", aliases: ["react native"] },
  { slug: "devops", label: "DevOps", aliases: ["devops"] },
  { slug: "devops-beginner", label: "DevOps Beginner", aliases: ["devops beginner", "beginner devops"] },
  { slug: "docker", label: "Docker", aliases: ["docker", "containers", "containerization"] },
  { slug: "kubernetes", label: "Kubernetes", aliases: ["kubernetes", "k8s"] },
  { slug: "aws", label: "AWS", aliases: ["aws", "amazon web services"] },
  { slug: "cloud-computing", label: "Cloud Computing", aliases: ["cloud computing", "cloud"] },
  { slug: "linux", label: "Linux", aliases: ["linux", "unix"] },
  { slug: "shell-bash", label: "Shell / Bash", aliases: ["shell", "bash", "shell scripting", "command line"] },
  { slug: "git-github", label: "Git and GitHub", aliases: ["git", "github", "version control"] },
  { slug: "git-github-beginner", label: "Git and GitHub Beginner", aliases: ["git beginner", "github beginner", "git and github beginner"] },
  { slug: "sql", label: "SQL", aliases: ["sql", "structured query language"] },
  { slug: "postgresql-dba", label: "PostgreSQL", aliases: ["postgresql", "postgres", "postgres dba"] },
  { slug: "mongodb", label: "MongoDB", aliases: ["mongodb", "mongo", "nosql"] },
  { slug: "redis", label: "Redis", aliases: ["redis"] },
  { slug: "graphql", label: "GraphQL", aliases: ["graphql"] },
  { slug: "api-design", label: "API Design", aliases: ["api design", "api", "rest api", "restful api"] },
  { slug: "system-design", label: "System Design", aliases: ["system design"] },
  { slug: "software-architect", label: "Software Architect", aliases: ["software architect", "architecture"] },
  { slug: "software-design-architecture", label: "Software Design and Architecture", aliases: ["software design", "software design and architecture", "design patterns"] },
  { slug: "cyber-security", label: "Cyber Security", aliases: ["cyber security", "cybersecurity", "security", "ethical hacking", "penetration testing"] },
  { slug: "devsecops", label: "DevSecOps", aliases: ["devsecops"] },
  { slug: "machine-learning", label: "Machine Learning", aliases: ["machine learning", "ml"] },
  { slug: "ai-engineer", label: "AI Engineer", aliases: ["ai engineer", "artificial intelligence", "ai engineering"] },
  { slug: "ai-agents", label: "AI Agents", aliases: ["ai agents", "ai agent", "agentic ai"] },
  { slug: "ai-data-scientist", label: "AI Data Scientist", aliases: ["data science", "data scientist", "ai data scientist"] },
  { slug: "data-analyst", label: "Data Analyst", aliases: ["data analyst", "data analysis"] },
  { slug: "data-engineer", label: "Data Engineer", aliases: ["data engineer", "data engineering"] },
  { slug: "python-data-analysis", label: "Python Data Analysis", aliases: ["python data analysis", "pandas", "numpy"] },
  { slug: "product-design", label: "Product Design", aliases: ["product design", "product designer"] },
  { slug: "ux-design", label: "UX Design", aliases: ["ux design", "ux", "user experience", "ui ux", "ui/ux"] },
  { slug: "design-system", label: "Design System", aliases: ["design system", "component library"] },
  { slug: "qa", label: "QA", aliases: ["qa", "quality assurance", "software testing"] },
  { slug: "blockchain", label: "Blockchain", aliases: ["blockchain", "web3", "smart contracts"] },
  { slug: "game-developer", label: "Game Development", aliases: ["game development", "game developer", "game dev", "unity", "unreal"] },
  { slug: "wordpress", label: "WordPress", aliases: ["wordpress"] },
  { slug: "seo", label: "SEO", aliases: ["seo", "search engine optimization"] },
  { slug: "technical-writer", label: "Technical Writing", aliases: ["technical writing", "technical writer"] },
  { slug: "engineering-manager", label: "Engineering Manager", aliases: ["engineering manager", "engineering management"] },
  { slug: "product-manager", label: "Product Manager", aliases: ["product manager", "product management"] },
  { slug: "computer-science", label: "Computer Science", aliases: ["computer science", "cs"] },
  {
    slug: "datastructures-and-algorithms",
    label: "Data Structures and Algorithms",
    aliases: ["data structures and algorithms", "data structures", "algorithms", "dsa"],
  },
  { slug: "leetcode", label: "LeetCode", aliases: ["leetcode", "coding interview"] },
  { slug: "prompt-engineering", label: "Prompt Engineering", aliases: ["prompt engineering", "prompting"] },
];

/** Lower-cases, folds common developer spellings, and collapses punctuation
 *  so "ASP.NET Core", "asp net core", and "aspnet-core" all match. */
export function normalizeRoadmapMatchText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/c\+\+/g, " cpp ")
    .replace(/c#/g, " csharp ")
    .replace(/asp\.net/g, " aspnet ")
    .replace(/\.net\b/g, " dotnet ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseScore(haystack: string, needle: string): number {
  const phrase = normalizeRoadmapMatchText(needle);
  if (!phrase) return 0;
  // Single letters ("c", "r") must match a whole word, never a substring.
  if (phrase.length < 2) return haystack === phrase ? 20 : 0;
  if (haystack === phrase) return 1000 + phrase.length;
  if (` ${haystack} `.includes(` ${phrase} `)) return 300 + phrase.length * 3;
  return 0;
}

export interface RoadmapMatch {
  slug: string;
  label: string;
}

/** Returns the best roadmap.sh topic for a category name. The category name
 *  carries most of the weight; subtopics only break ties, since a category
 *  called "Web Development" with a "React" focus should still use the
 *  frontend roadmap rather than the React one. */
export function resolveDeveloperRoadmapSlug(
  categoryName: string,
  subtopics: string[] = [],
): RoadmapMatch | null {
  const category = normalizeRoadmapMatchText(categoryName);
  const combined = normalizeRoadmapMatchText([categoryName, ...subtopics].join(" "));
  if (!category && !combined) return null;

  let best: { topic: DeveloperRoadmapTopic; score: number } | null = null;

  for (const topic of DEVELOPER_ROADMAP_TOPICS) {
    const candidates = [topic.label, topic.slug.replace(/-/g, " "), ...topic.aliases];
    let score = 0;
    for (const candidate of candidates) {
      const categoryScore = phraseScore(category, candidate);
      const combinedScore = phraseScore(combined, candidate);
      score = Math.max(score, categoryScore, combinedScore * 0.5);
    }
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }

  return best ? { slug: best.topic.slug, label: best.topic.label } : null;
}

export function developerRoadmapUrl(slug: string): string {
  return `https://roadmap.sh/${slug}`;
}

export function developerRoadmapJsonUrl(slug: string): string {
  return `https://roadmap.sh/${slug}.json`;
}
