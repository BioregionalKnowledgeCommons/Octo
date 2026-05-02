import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import style from "./styles/sourceAttribution.scss"

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function SourceAttribution({ fileData, displayClass }: QuartzComponentProps) {
  const fm = fileData.frontmatter as Record<string, unknown> | undefined
  if (!fm) return null

  // Resolve source URL + name. Two supported shapes:
  //   1. Explicit attribution fields (wiki backfill, future ingest paths):
  //      source_url, source_name, source_license, source_license_url
  //   2. Web-source entity (schema:WebPage with `url:`) — the entity IS the
  //      source artifact. This covers both web_router.write_vault_note's
  //      output (source: "web_ingest") and older seeded WebPage notes.
  // Plain `url:` fields on Person/Organization/etc notes (e.g. a LinkedIn
  // link) are NOT attribution — guarded by requiring @type === schema:WebPage.
  let sourceUrl = fm.source_url as string | undefined
  let sourceName = fm.source_name as string | undefined
  let isWebSource = false

  if (!sourceUrl) {
    const atType = ((fm["@type"] ?? fm.type) as string | undefined)?.toString()
    if (atType === "schema:WebPage" && fm.url) {
      sourceUrl = fm.url as string
      isWebSource = true
    }
  }

  if (!sourceUrl) return null
  if (!sourceName) sourceName = extractDomain(sourceUrl)

  const license = fm.source_license as string | undefined
  const licenseUrl = fm.source_license_url as string | undefined
  const dateAccessed = fm.dateAccessed as string | undefined

  return (
    <footer class={classNames(displayClass, "source-attribution")}>
      <span>
        Source:{" "}
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          {sourceName}
        </a>
      </span>
      {license ? (
        <span>
          {" · License: "}
          {licenseUrl ? (
            <a href={licenseUrl} target="_blank" rel="noopener noreferrer">
              {license}
            </a>
          ) : (
            license
          )}
        </span>
      ) : null}
      {isWebSource && dateAccessed ? <span>{` · Accessed: ${dateAccessed}`}</span> : null}
    </footer>
  )
}

SourceAttribution.css = style

export default (() => SourceAttribution) satisfies QuartzComponentConstructor
