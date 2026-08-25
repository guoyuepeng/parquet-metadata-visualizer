import { useState, useEffect } from 'react'
import type { ParquetPageMetadata, PageInfo, PageSizeBreakdown } from '../../../src/lib/parquet-parsing'
import { parseParquetPage, parsePageDataSizes, calculateMaxLevels, decompressPagePayload } from '../../../src/lib/parquet-parsing'
import './PagesView.css'

type PageStatistics = NonNullable<NonNullable<PageInfo['dataPageHeader']>['statistics']>

function formatBytes(value: number | bigint | undefined): string {
  return value === undefined ? 'Not available' : `${value.toLocaleString()} bytes`
}

function formatOffset(value: number | bigint | undefined): string {
  return value === undefined ? 'Not available' : value.toLocaleString()
}

function formatCrc(value: number | undefined): string {
  if (value === undefined) return 'Not present'
  return `0x${(value >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
}

function formatMetadataValue(value: unknown): string {
  if (value === undefined || value === null) return 'Not present'
  if (typeof value === 'bigint' || typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return value
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()

  if (value instanceof Uint8Array) {
    const limit = 24
    const bytes = Array.from(value.subarray(0, limit))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join(' ')
    return `0x${bytes}${value.byteLength > limit ? ' …' : ''} (${value.byteLength} bytes)`
  }

  return String(value)
}

function pageKindLabel(pageType?: string): string {
  if (pageType === 'DICTIONARY_PAGE') return 'Dictionary page'
  if (pageType === 'DATA_PAGE') return 'Data page V1'
  if (pageType === 'DATA_PAGE_V2') return 'Data page V2'
  if (pageType === 'INDEX_PAGE') return 'Index page'
  return 'Unknown page type'
}

function MetadataField({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`page-metadata-field${wide ? ' wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function PageStatisticsDetails({ statistics }: { statistics?: PageStatistics }) {
  if (!statistics) return null

  const fields = [
    ['Null count', statistics.null_count],
    ['Distinct count', statistics.distinct_count],
    ['Minimum', statistics.min_value ?? statistics.min],
    ['Maximum', statistics.max_value ?? statistics.max],
    ['Minimum exact', statistics.is_min_value_exact],
    ['Maximum exact', statistics.is_max_value_exact],
  ].filter(([, value]) => value !== undefined)

  if (fields.length === 0) return null

  return (
    <div className="page-specific-block page-statistics-block">
      <h5>Page-header statistics</h5>
      <dl className="page-metadata-grid compact">
        {fields.map(([label, value]) => (
          <MetadataField key={String(label)} label={String(label)} value={formatMetadataValue(value)} />
        ))}
      </dl>
    </div>
  )
}

function ColumnIndexDetails({ page }: { page: PageInfo }) {
  const entry = page.columnIndex
  if (!entry) return null

  return (
    <div className="page-specific-block column-index-statistics-block">
      <h5>ColumnIndex statistics</h5>
      <dl className="page-metadata-grid compact">
        <MetadataField label="Index entry" value={entry.index.toLocaleString()} />
        <MetadataField label="Null-only page" value={entry.nullPage ? 'Yes' : 'No'} />
        <MetadataField label="Minimum bound" value={formatMetadataValue(entry.min)} />
        <MetadataField label="Maximum bound" value={formatMetadataValue(entry.max)} />
        <MetadataField label="Null count" value={formatMetadataValue(entry.nullCount)} />
        {entry.nanCount !== undefined && (
          <MetadataField label="NaN count" value={formatMetadataValue(entry.nanCount)} />
        )}
        <MetadataField label="Boundary order" value={entry.boundaryOrder} />
        <MetadataField label="Statistics source" value="ColumnIndex" />
      </dl>
    </div>
  )
}

interface PagesViewProps {
  metadata: ParquetPageMetadata
  file: File
  initialRowGroup?: number | null
  initialColumn?: number | null
}

function PagesView({ metadata, file, initialRowGroup, initialColumn }: PagesViewProps) {
  const { rowGroups } = metadata
  const [selectedRowGroup, setSelectedRowGroup] = useState<number>(initialRowGroup ?? 0)
  const [selectedColumn, setSelectedColumn] = useState<number | null>(initialColumn ?? null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [pageSizeBreakdowns, setPageSizeBreakdowns] = useState<PageSizeBreakdown[]>([])
  const [isLoadingPages, setIsLoadingPages] = useState(false)
  const [pageLoadError, setPageLoadError] = useState<string | null>(null)

  // Update selection when initial values change
  useEffect(() => {
    if (initialRowGroup !== null && initialRowGroup !== undefined) {
      setSelectedRowGroup(initialRowGroup)
    }
    if (initialColumn !== null && initialColumn !== undefined) {
      setSelectedColumn(initialColumn)
    }
  }, [initialRowGroup, initialColumn])

  const currentRowGroup = rowGroups[selectedRowGroup]
  const currentColumn = selectedColumn !== null ? currentRowGroup?.columns[selectedColumn] : null
  const currentRawColumnChunk = selectedColumn !== null
    ? metadata.fileMetadata.rowGroups[selectedRowGroup]?.columns[selectedColumn]
    : null
  const currentRawColumnMetadata = currentRawColumnChunk?.meta_data

  // Load pages when column is selected
  useEffect(() => {
    if (!currentColumn || selectedColumn === null) return

    const loadPages = async () => {
      setIsLoadingPages(true)
      setPageLoadError(null)
      setPages([])
      setPageSizeBreakdowns([])
      try {
        const rawColumnChunk = metadata.fileMetadata.rowGroups[selectedRowGroup].columns[selectedColumn];
        const columnMetadata = rawColumnChunk.meta_data!!; // assume not undefined
        const byteRangeReader = async (offset: number, length: number): Promise<ArrayBuffer> => {
          const slice = file.slice(offset, offset + length)
          return await slice.arrayBuffer()
        }
        const parsedPages = await parseParquetPage(
          rawColumnChunk,
          byteRangeReader,
          metadata.fileMetadata.schema
        )
        setPages(parsedPages)

        // Calculate max levels for this column
        const columnPath = columnMetadata.path_in_schema
        const { maxRepetitionLevel, maxDefinitionLevel } = calculateMaxLevels(
          metadata.fileMetadata.schema,
          columnPath
        )

        // Get the compression codec for this column
        const codec = columnMetadata.codec

        // Parse size breakdowns for each page
        const breakdowns: PageSizeBreakdown[] = []
        for (const page of parsedPages) {
          try {
            const pageOffset = Number(page.offset)
            const headerSize = page.headerSize || 0
            const compressedSize = page.compressedSize || 0

            // Read the compressed page data (after header)
            const compressedData = await byteRangeReader(pageOffset + headerSize, compressedSize)

            const uncompressedBytes = decompressPagePayload(page, compressedData, codec)

            // Parse the page data sizes
            const breakdown = parsePageDataSizes(
              page,
              uncompressedBytes,
              maxRepetitionLevel,
              maxDefinitionLevel
            )
            breakdowns.push(breakdown)
          } catch (error) {
            console.warn(`Failed to parse size breakdown for page ${page.pageNumber}:`, error)
          }
        }
        setPageSizeBreakdowns(breakdowns)
      } catch (error) {
        console.error('Error loading pages:', error)
        setPageLoadError(error instanceof Error ? error.message : String(error))
        setPages([])
        setPageSizeBreakdowns([])
      } finally {
        setIsLoadingPages(false)
      }
    }

    loadPages()
  }, [selectedRowGroup, selectedColumn, currentColumn, metadata.fileMetadata, file])

  const pageBreakdownsByNumber = new Map(
    pageSizeBreakdowns.map(breakdown => [breakdown.pageNumber, breakdown])
  )
  const dictionaryPageCount = pages.filter(page => page.pageType === 'DICTIONARY_PAGE').length
  const dataPageCount = pages.filter(
    page => page.pageType === 'DATA_PAGE' || page.pageType === 'DATA_PAGE_V2'
  ).length
  const totalPageHeaderBytes = pages.reduce((sum, page) => sum + (page.headerSize ?? 0), 0)
  const totalParsedOnDiskBytes = pages.reduce(
    (sum, page) => sum + (page.headerSize ?? 0) + (page.compressedSize ?? 0),
    0
  )
  const chunkStart = currentRawColumnMetadata
    ? Number(currentRawColumnMetadata.dictionary_page_offset ?? currentRawColumnMetadata.data_page_offset)
    : undefined
  const chunkEnd = chunkStart !== undefined && currentRawColumnMetadata
    ? chunkStart + Number(currentRawColumnMetadata.total_compressed_size)
    : undefined

  return (
    <div className="pages-view">
      <section className="pages-section">
        <h2>Page-Level Analysis</h2>
        <p className="pages-description">
          Explore pages within column chunks across row groups. Pages are the smallest unit of data storage in Parquet files.
        </p>

        {selectedColumn !== null && (
          <div className="selected-column-info">
            <strong>Selected Column:</strong> Column {selectedColumn}: {currentColumn?.columnName}
          </div>
        )}

        {selectedColumn === null && (
          <div className="no-column-selected">
            <p>👆 Click on a column in the Structure tab to view its page details</p>
          </div>
        )}
      </section>

      {currentColumn && (
        <>
          <section className="pages-section">
            <h3>Column Chunk Summary</h3>
            <div className="column-chunk-summary">
              <div className="summary-grid">
                <div className="summary-item">
                  <span className="summary-label">Column Name:</span>
                  <span className="summary-value">{currentColumn.columnName}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Row Group / Column:</span>
                  <span className="summary-value">RG {selectedRowGroup} / Column {selectedColumn}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Physical Type:</span>
                  <span className="summary-value">{currentColumn.physicalType}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Compression:</span>
                  <span className="summary-value">{currentColumn.compressionCodec}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Total Pages:</span>
                  <span className="summary-value">
                    {isLoadingPages ? 'Loading...' : pages.length}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Data / Dictionary Pages:</span>
                  <span className="summary-value">
                    {isLoadingPages ? 'Loading...' : `${dataPageCount} / ${dictionaryPageCount}`}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Total Values:</span>
                  <span className="summary-value">{currentColumn.totalValues.toLocaleString()}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Compressed Size:</span>
                  <span className="summary-value">
                    {currentColumn.totalCompressedSize.toLocaleString()} bytes
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Uncompressed Size:</span>
                  <span className="summary-value">
                    {currentColumn.totalUncompressedSize.toLocaleString()} bytes
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Column Chunk Range:</span>
                  <span className="summary-value mono-value">
                    {chunkStart === undefined || chunkEnd === undefined
                      ? 'Not available'
                      : `[${chunkStart.toLocaleString()}, ${chunkEnd.toLocaleString()})`}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">First Data Page Offset:</span>
                  <span className="summary-value mono-value">
                    {formatOffset(currentRawColumnMetadata?.data_page_offset)}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Dictionary Page Offset:</span>
                  <span className="summary-value mono-value">
                    {currentRawColumnMetadata?.dictionary_page_offset === undefined
                      ? 'None'
                      : formatOffset(currentRawColumnMetadata.dictionary_page_offset)}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Offset Index:</span>
                  <span className="summary-value mono-value">
                    {currentRawColumnChunk?.offset_index_offset === undefined || currentRawColumnChunk.offset_index_length === undefined
                      ? 'Not present'
                      : `${currentRawColumnChunk.offset_index_offset.toLocaleString()} · ${currentRawColumnChunk.offset_index_length.toLocaleString()} bytes`}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Column Index:</span>
                  <span className="summary-value mono-value">
                    {currentRawColumnChunk?.column_index_offset === undefined || currentRawColumnChunk.column_index_length === undefined
                      ? 'Not present'
                      : `${currentRawColumnChunk.column_index_offset.toLocaleString()} · ${currentRawColumnChunk.column_index_length.toLocaleString()} bytes`}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Page Header Overhead:</span>
                  <span className="summary-value">
                    {isLoadingPages ? 'Loading...' : formatBytes(totalPageHeaderBytes)}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Parsed On-Disk Bytes:</span>
                  <span className="summary-value">
                    {isLoadingPages ? 'Loading...' : formatBytes(totalParsedOnDiskBytes)}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Compression Ratio:</span>
                  <span className="summary-value">{currentColumn.compressionRatio}x</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Encodings:</span>
                  <span className="summary-value">{currentColumn.encodings.join(', ')}</span>
                </div>
              </div>
            </div>
          </section>

          {pageLoadError && (
            <section className="pages-section page-error" role="alert">
              <h3>Unable to parse pages</h3>
              <p>{pageLoadError}</p>
            </section>
          )}

          {!isLoadingPages && pages.length > 0 && (
            <section className="pages-section">
              <div className="section-title-row">
                <div>
                  <h3>Page Details</h3>
                  <p className="section-helper-text">
                    Every page is a Thrift header followed immediately by its payload. Data page payloads contain
                    repetition levels, definition levels, and encoded values in that order. Dictionary pages are
                    shown explicitly and are not part of the page indexes. When present, ColumnIndex bounds and null
                    counts are joined to the corresponding data page below.
                  </p>
                </div>
                <a
                  className="format-doc-link"
                  href="https://parquet.apache.org/docs/file-format/data-pages/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Apache format reference ↗
                </a>
              </div>

              <div className="page-details-list">
                {pages.map(page => {
                  const pageOffset = Number(page.offset ?? 0n)
                  const headerSize = page.headerSize ?? 0
                  const compressedPayloadSize = page.compressedSize ?? 0
                  const uncompressedPayloadSize = page.uncompressedSize ?? compressedPayloadSize
                  const payloadOffset = pageOffset + headerSize
                  const totalOnDiskSize = headerSize + compressedPayloadSize
                  const pageEnd = pageOffset + totalOnDiskSize
                  const compressionRatio = compressedPayloadSize > 0
                    ? uncompressedPayloadSize / compressedPayloadSize
                    : 0
                  const breakdown = pageBreakdownsByNumber.get(page.pageNumber)
                  const statistics = page.dataPageHeader?.statistics ?? page.dataPageHeaderV2?.statistics
                  const pageTypeClass = (page.pageType ?? 'UNKNOWN').toLowerCase()

                  return (
                    <article key={page.pageNumber} className={`page-card detailed ${pageTypeClass}`}>
                      <header className="page-card-header">
                        <div className="page-card-title">
                          <span className="page-number">Page {page.pageNumber}</span>
                          <span className={`page-type ${pageTypeClass}`}>{pageKindLabel(page.pageType)}</span>
                          {page.encoding && <span className="page-encoding">{page.encoding}</span>}
                        </div>
                        <span className="page-range">[{pageOffset.toLocaleString()}, {pageEnd.toLocaleString()})</span>
                      </header>

                      <div className="page-byte-layout">
                        <div className="page-layout-segment header-segment">
                          <span>Page header</span>
                          <strong>{formatBytes(headerSize)}</strong>
                          <small>offset {pageOffset.toLocaleString()}</small>
                        </div>
                        <div className="page-layout-arrow" aria-hidden="true">→</div>
                        <div className="page-layout-segment payload-segment">
                          <span>Compressed payload</span>
                          <strong>{formatBytes(compressedPayloadSize)}</strong>
                          <small>offset {payloadOffset.toLocaleString()}</small>
                        </div>
                      </div>

                      <dl className="page-metadata-grid">
                        <MetadataField label="Header offset" value={formatOffset(page.offset)} />
                        <MetadataField label="Header size" value={formatBytes(page.headerSize)} />
                        <MetadataField label="Payload offset" value={payloadOffset.toLocaleString()} />
                        <MetadataField label="Compressed payload" value={formatBytes(page.compressedSize)} />
                        <MetadataField label="Uncompressed payload" value={formatBytes(page.uncompressedSize)} />
                        <MetadataField label="Total on-disk size" value={formatBytes(totalOnDiskSize)} />
                        <MetadataField
                          label="Payload compression ratio"
                          value={compressionRatio > 0 ? `${compressionRatio.toFixed(2)}x` : 'Not available'}
                        />
                        <MetadataField label="CRC32" value={formatCrc(page.crc)} />
                        {page.offsetIndexCompressedSize !== undefined && (
                          <MetadataField
                            label="OffsetIndex page size"
                            value={`${formatBytes(page.offsetIndexCompressedSize)}${page.offsetIndexCompressedSize === totalOnDiskSize ? ' · matches' : ' · differs'}`}
                          />
                        )}
                        {page.firstRowIndex !== undefined && (
                          <MetadataField label="First row from OffsetIndex" value={page.firstRowIndex.toLocaleString()} />
                        )}
                      </dl>

                      {page.dictionaryPageHeader && (
                        <div className="page-specific-block dictionary-metadata">
                          <h5>Dictionary metadata</h5>
                          <dl className="page-metadata-grid compact">
                            <MetadataField
                              label="Dictionary entries"
                              value={page.dictionaryPageHeader.num_values.toLocaleString()}
                            />
                            <MetadataField label="Dictionary encoding" value={page.dictionaryPageHeader.encoding} />
                            <MetadataField
                              label="Entries sorted"
                              value={page.dictionaryPageHeader.is_sorted === undefined
                                ? 'Not specified'
                                : page.dictionaryPageHeader.is_sorted ? 'Yes' : 'No'}
                            />
                            <MetadataField label="Position in chunk" value="First page" />
                          </dl>
                        </div>
                      )}

                      {page.dataPageHeader && (
                        <div className="page-specific-block data-page-metadata">
                          <h5>Data page V1 metadata</h5>
                          <dl className="page-metadata-grid compact">
                            <MetadataField label="Data page ordinal" value={(page.dataPageIndex ?? 0).toLocaleString()} />
                            <MetadataField label="Values including nulls" value={page.dataPageHeader.num_values.toLocaleString()} />
                            <MetadataField label="Value encoding" value={page.dataPageHeader.encoding} />
                            <MetadataField label="Repetition-level encoding" value={page.dataPageHeader.repetition_level_encoding} />
                            <MetadataField label="Definition-level encoding" value={page.dataPageHeader.definition_level_encoding} />
                            <MetadataField label="Payload order" value="Repetition levels → Definition levels → Encoded values" wide />
                          </dl>
                        </div>
                      )}

                      {page.dataPageHeaderV2 && (
                        <div className="page-specific-block data-page-v2-metadata">
                          <h5>Data page V2 metadata</h5>
                          <dl className="page-metadata-grid compact">
                            <MetadataField label="Data page ordinal" value={(page.dataPageIndex ?? 0).toLocaleString()} />
                            <MetadataField label="Rows" value={page.dataPageHeaderV2.num_rows.toLocaleString()} />
                            <MetadataField label="Values including nulls" value={page.dataPageHeaderV2.num_values.toLocaleString()} />
                            <MetadataField label="Null values" value={page.dataPageHeaderV2.num_nulls.toLocaleString()} />
                            <MetadataField
                              label="Non-null values"
                              value={(page.dataPageHeaderV2.num_values - page.dataPageHeaderV2.num_nulls).toLocaleString()}
                            />
                            <MetadataField label="Value encoding" value={page.dataPageHeaderV2.encoding} />
                            <MetadataField
                              label="Repetition levels"
                              value={`${formatBytes(page.dataPageHeaderV2.repetition_levels_byte_length)} · uncompressed`}
                            />
                            <MetadataField
                              label="Definition levels"
                              value={`${formatBytes(page.dataPageHeaderV2.definition_levels_byte_length)} · uncompressed`}
                            />
                            <MetadataField
                              label="Values compressed"
                              value={page.dataPageHeaderV2.is_compressed ? 'Yes' : 'No'}
                            />
                          </dl>
                        </div>
                      )}

                      {breakdown && (
                        <div className="page-specific-block page-payload-breakdown">
                          <h5>{page.dictionaryPageHeader ? 'Dictionary payload' : 'Uncompressed payload breakdown'}</h5>
                          <dl className="page-metadata-grid compact">
                            {!page.dictionaryPageHeader && (
                              <>
                                <MetadataField label="Repetition levels" value={formatBytes(breakdown.repetitionLevelsSize)} />
                                <MetadataField label="Definition levels" value={formatBytes(breakdown.definitionLevelsSize)} />
                              </>
                            )}
                            <MetadataField
                              label={page.dictionaryPageHeader ? 'Encoded dictionary values' : 'Encoded values'}
                              value={formatBytes(breakdown.valuesSize)}
                            />
                            <MetadataField label="Total payload" value={formatBytes(breakdown.totalDataSize)} />
                            {breakdown.nullCount !== undefined && (
                              <MetadataField label="Decoded null count" value={breakdown.nullCount.toLocaleString()} />
                            )}
                          </dl>
                        </div>
                      )}

                      <ColumnIndexDetails page={page} />
                      <PageStatisticsDetails statistics={statistics} />
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {currentColumn.encodingStats && currentColumn.encodingStats.length > 0 && (
            <section className="pages-section">
              <h3>Encoding Statistics</h3>
              <div className="encoding-stats">
                {currentColumn.encodingStats.map((stat, idx) => (
                  <div key={idx} className="encoding-stat-card">
                    <div className="stat-header">
                      <span className="stat-type">{stat.pageType}</span>
                      <span className="stat-count">{stat.count} pages</span>
                    </div>
                    <div className="stat-encoding">{stat.encoding}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!isLoadingPages && pages.length > 0 && (
            <section className="pages-section">
              <h3>Page Statistics Summary</h3>
              {(() => {
                // Calculate statistics grouped by page type
                const statsByType = pages.reduce((acc, page) => {
                  const type = page.pageType || 'UNKNOWN'
                  if (!acc[type]) {
                    acc[type] = {
                      count: 0,
                      totalCompressedSize: 0,
                      totalUncompressedSize: 0,
                      minCompressedSize: Infinity,
                      maxCompressedSize: -Infinity,
                      minUncompressedSize: Infinity,
                      maxUncompressedSize: -Infinity,
                      totalNumValues: 0,
                      pagesWithNumValues: 0,
                      pages: []
                    }
                  }
                  acc[type].count++
                  if (page.compressedSize !== undefined) {
                    acc[type].totalCompressedSize += page.compressedSize
                    acc[type].minCompressedSize = Math.min(acc[type].minCompressedSize, page.compressedSize)
                    acc[type].maxCompressedSize = Math.max(acc[type].maxCompressedSize, page.compressedSize)
                  }
                  if (page.uncompressedSize !== undefined) {
                    acc[type].totalUncompressedSize += page.uncompressedSize
                    acc[type].minUncompressedSize = Math.min(acc[type].minUncompressedSize, page.uncompressedSize)
                    acc[type].maxUncompressedSize = Math.max(acc[type].maxUncompressedSize, page.uncompressedSize)
                  }
                  if (page.numValues !== undefined) {
                    acc[type].totalNumValues += page.numValues
                    acc[type].pagesWithNumValues++
                  }
                  acc[type].pages.push(page)
                  return acc
                }, {} as Record<string, {
                  count: number
                  totalCompressedSize: number
                  totalUncompressedSize: number
                  minCompressedSize: number
                  maxCompressedSize: number
                  minUncompressedSize: number
                  maxUncompressedSize: number
                  totalNumValues: number
                  pagesWithNumValues: number
                  pages: PageInfo[]
                }>)

                return (
                  <div className="page-stats-grid">
                    {Object.entries(statsByType).map(([pageType, stats]) => {
                      const avgCompressed = stats.count > 0 ? stats.totalCompressedSize / stats.count : 0
                      const avgUncompressed = stats.count > 0 ? stats.totalUncompressedSize / stats.count : 0
                      const avgCompressionRatio = avgCompressed > 0 ? avgUncompressed / avgCompressed : 0

                      // Calculate average values per page from numValues field
                      const avgValuesPerPage = stats.pagesWithNumValues > 0
                        ? stats.totalNumValues / stats.pagesWithNumValues
                        : 0

                      return (
                        <div key={pageType} className="page-stat-card">
                          <div className="page-stat-header">
                            <span className={`page-type-badge ${pageType.toLowerCase()}`}>
                              {pageType}
                            </span>
                            <span className="page-stat-count">{stats.count} pages</span>
                          </div>
                          <div className="page-stat-body">
                            {stats.totalCompressedSize > 0 && (
                              <>
                                <div className="stat-row">
                                  <span className="stat-label">Compressed Size:</span>
                                  <div className="stat-values">
                                    <div>Avg: {avgCompressed.toLocaleString(undefined, {maximumFractionDigits: 0})} bytes</div>
                                    <div className="stat-range">
                                      Min: {stats.minCompressedSize.toLocaleString()} |
                                      Max: {stats.maxCompressedSize.toLocaleString()}
                                    </div>
                                  </div>
                                </div>
                                <div className="stat-row">
                                  <span className="stat-label">Uncompressed Size:</span>
                                  <div className="stat-values">
                                    <div>Avg: {avgUncompressed.toLocaleString(undefined, {maximumFractionDigits: 0})} bytes</div>
                                    <div className="stat-range">
                                      Min: {stats.minUncompressedSize.toLocaleString()} |
                                      Max: {stats.maxUncompressedSize.toLocaleString()}
                                    </div>
                                  </div>
                                </div>
                                <div className="stat-row">
                                  <span className="stat-label">Compression Ratio:</span>
                                  <div className="stat-values">
                                    <div className="stat-highlight">
                                      {avgCompressionRatio.toFixed(2)}x
                                    </div>
                                  </div>
                                </div>
                              </>
                            )}
                            {avgValuesPerPage > 0 && (
                              <div className="stat-row">
                                <span className="stat-label">Avg Values/Page:</span>
                                <div className="stat-values">
                                  <div className="stat-highlight">
                                    {avgValuesPerPage.toLocaleString(undefined, {maximumFractionDigits: 0})}
                                  </div>
                                </div>
                              </div>
                            )}
                            {stats.totalCompressedSize === 0 && stats.totalUncompressedSize === 0 && (
                              <div className="stat-row">
                                <span className="stat-info">Size information not available</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </section>
          )}

          <section className="pages-section">
            <h3>Page Size Histogram</h3>
            {isLoadingPages ? (
              <p className="no-pages">Loading page data...</p>
            ) : pages.length > 0 && pages.some(p => p.compressedSize || p.uncompressedSize) ? (
              <>
                <div className="histogram-legend">
                  <div className="legend-item">
                    <div className="legend-color legend-header"></div>
                    <span>Page Header</span>
                  </div>
                  <div className="legend-divider"></div>
                  {(() => {
                    // Get unique encodings from pages
                    const encodings = new Set(pages.map(p => p.encoding).filter(Boolean))
                    return Array.from(encodings).sort().map(encoding => (
                      <div key={encoding} className="legend-item">
                        <div className={`legend-color encoding-${encoding?.toLowerCase().replace(/_/g, '-')}`}></div>
                        <span>{encoding}</span>
                      </div>
                    ))
                  })()}
                </div>
                <div className="histogram-container">
                  {(() => {
                    // Filter pages with size information
                    const pagesWithSizes = pages.filter(p => p.compressedSize || p.uncompressedSize)

                    // Find max size for scaling (include header size in total)
                    const maxSize = Math.max(
                      ...pagesWithSizes.map(p => {
                        const headerSize = p.headerSize || 0
                        const compressedWithHeader = (p.compressedSize || 0) + headerSize
                        const uncompressedWithHeader = (p.uncompressedSize || 0) + headerSize
                        return Math.max(compressedWithHeader, uncompressedWithHeader)
                      })
                    )

                    return (
                      <div className="histogram">
                        {pagesWithSizes.map((page, idx) => {
                          const encoding = (page.encoding || 'unknown').toLowerCase().replace(/_/g, '-')
                          const headerSize = page.headerSize || 0

                          // Calculate heights including header
                          const compressedDataHeight = page.compressedSize ? (page.compressedSize / maxSize) * 100 : 0
                          const uncompressedDataHeight = page.uncompressedSize ? (page.uncompressedSize / maxSize) * 100 : 0
                          const headerHeight = headerSize ? (headerSize / maxSize) * 100 : 0

                          // Build comprehensive tooltip with statistics
                          const buildTooltip = () => {
                            const lines = [
                              `Page ${page.pageNumber}: ${page.pageType || 'UNKNOWN'}`,
                              `Encoding: ${page.encoding || 'Unknown'}`,
                              `Header: ${page.headerSize?.toLocaleString() || 'N/A'} bytes`,
                              `Compressed: ${page.compressedSize?.toLocaleString() || 'N/A'} bytes`,
                              `Uncompressed: ${page.uncompressedSize?.toLocaleString() || 'N/A'} bytes`,
                              `Total (Header + Compressed): ${((page.headerSize || 0) + (page.compressedSize || 0)).toLocaleString()} bytes`,
                            ]

                            // Add page size breakdown if available
                            const breakdown = pageSizeBreakdowns.find(b => b.pageNumber === page.pageNumber)
                            if (breakdown) {
                              lines.push('')
                              lines.push('--- Page Data Breakdown ---')
                              lines.push(`Repetition Levels: ${breakdown.repetitionLevelsSize.toLocaleString()} bytes`)
                              lines.push(`Definition Levels: ${breakdown.definitionLevelsSize.toLocaleString()} bytes`)
                              lines.push(`Values: ${breakdown.valuesSize.toLocaleString()} bytes`)

                              // Calculate percentages
                              const total = breakdown.totalDataSize
                              if (total > 0) {
                                const repPercent = ((breakdown.repetitionLevelsSize / total) * 100).toFixed(1)
                                const defPercent = ((breakdown.definitionLevelsSize / total) * 100).toFixed(1)
                                const valPercent = ((breakdown.valuesSize / total) * 100).toFixed(1)
                                lines.push(`Distribution: Rep ${repPercent}% | Def ${defPercent}% | Val ${valPercent}%`)
                              }

                              // Add null count if available
                              if (breakdown.nullCount !== undefined) {
                                lines.push(`Null Count: ${breakdown.nullCount.toLocaleString()}`)
                              }
                            }

                            // Add numValues
                            if (page.numValues !== undefined) {
                              lines.push(``)
                              lines.push(`Values Count: ${page.numValues.toLocaleString()}`)
                            }

                            if (page.columnIndex) {
                              lines.push('')
                              lines.push('--- ColumnIndex Statistics ---')
                              lines.push(`Entry: ${page.columnIndex.index}`)
                              lines.push(`Null-only page: ${page.columnIndex.nullPage ? 'Yes' : 'No'}`)
                              lines.push(`Min: ${formatMetadataValue(page.columnIndex.min)}`)
                              lines.push(`Max: ${formatMetadataValue(page.columnIndex.max)}`)
                              lines.push(`Nulls: ${formatMetadataValue(page.columnIndex.nullCount)}`)
                              if (page.columnIndex.nanCount !== undefined) {
                                lines.push(`NaNs: ${formatMetadataValue(page.columnIndex.nanCount)}`)
                              }
                              lines.push(`Boundary order: ${page.columnIndex.boundaryOrder}`)
                            }

                            // Add statistics from data page header
                            if (page.dataPageHeader?.statistics) {
                              const stats = page.dataPageHeader.statistics
                              lines.push('')
                              lines.push('--- Page-header Statistics ---')
                              if (stats.null_count !== undefined) {
                                lines.push(`Nulls: ${stats.null_count}`)
                              }
                              if (stats.distinct_count !== undefined) {
                                lines.push(`Distinct: ${stats.distinct_count}`)
                              }
                              if (stats.min !== undefined || stats.min_value !== undefined) {
                                const minVal = stats.min_value !== undefined ? stats.min_value : stats.min
                                lines.push(`Min: ${minVal}`)
                              }
                              if (stats.max !== undefined || stats.max_value !== undefined) {
                                const maxVal = stats.max_value !== undefined ? stats.max_value : stats.max
                                lines.push(`Max: ${maxVal}`)
                              }
                            }

                            // Add statistics from data page header v2
                            if (page.dataPageHeaderV2) {
                              lines.push('')
                              lines.push('--- Statistics (V2) ---')
                              if (page.dataPageHeaderV2.num_nulls !== undefined) {
                                lines.push(`Nulls: ${page.dataPageHeaderV2.num_nulls}`)
                              }
                              if (page.dataPageHeaderV2.num_rows !== undefined) {
                                lines.push(`Rows: ${page.dataPageHeaderV2.num_rows}`)
                              }
                            }

                            return lines.join('\n')
                          }

                          const tooltip = buildTooltip()

                          return (
                            <div key={idx} className="histogram-bar-group" title={tooltip}>
                              <div className="histogram-bars">
                                {/* Header bar (at bottom, grey) */}
                                {headerSize > 0 && (
                                  <div
                                    className="histogram-bar header"
                                    style={{ height: `${headerHeight}%` }}
                                    title={tooltip}
                                  >
                                    {headerHeight > 3 && (
                                      <span className="bar-label bar-label-header">H</span>
                                    )}
                                  </div>
                                )}
                                {/* Uncompressed bar (background) */}
                                {page.uncompressedSize && (
                                  <div
                                    className={`histogram-bar uncompressed encoding-${encoding}`}
                                    style={{
                                      height: `${uncompressedDataHeight}%`,
                                      bottom: `${headerHeight}%`
                                    }}
                                    title={tooltip}
                                  >
                                    <span className="bar-label bar-label-uncompressed">{(page.uncompressedSize / 1024).toFixed(1)}K</span>
                                  </div>
                                )}
                                {/* Compressed bar (foreground) */}
                                {page.compressedSize && (
                                  <div
                                    className={`histogram-bar compressed encoding-${encoding}`}
                                    style={{
                                      height: `${compressedDataHeight}%`,
                                      bottom: `${headerHeight}%`
                                    }}
                                    title={tooltip}
                                  >
                                    <span className="bar-label bar-label-compressed">{(page.compressedSize / 1024).toFixed(1)}K</span>
                                  </div>
                                )}
                              </div>
                              <div className="histogram-labels">
                                <div className="histogram-label">P{page.pageNumber}</div>
                                {page.pageType === 'DICTIONARY_PAGE' ? (
                                  <div className="histogram-label-dict">DIC</div>
                                ) : page.pageType === 'DATA_PAGE' ? (
                                  <div className="histogram-label-data">DV1</div>
                                ) : page.pageType === 'DATA_PAGE_V2' ? (
                                  <div className="histogram-label-data">DV2</div>
                                ) : (
                                  <div className="histogram-label-dict histogram-label-placeholder"></div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
                <div className="histogram-info">
                  <p>Showing {pages.filter(p => p.compressedSize || p.uncompressedSize).length} pages with size information</p>
                </div>
              </>
            ) : (
              <p className="no-pages">No page size information available for visualization.</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default PagesView
