"""Response models of the platform domain."""

from pydantic import BaseModel


class MallinfoStats(BaseModel):
    """glibc allocator state, named after its ``mallinfo2`` fields."""

    arena: int
    hblkhd: int
    uordblks: int
    fordblks: int
    keepcost: int


class TypeCount(BaseModel):
    """How many live objects the garbage collector tracks of one type."""

    type: str
    count: int


class AllocationStat(BaseModel):
    """Live traced memory allocated at one source line, or in one file."""

    location: str
    size_bytes: int
    count: int


class AllocationGrowth(BaseModel):
    """How far one source line's traced memory has grown past the baseline."""

    location: str
    size_diff_bytes: int
    count_diff: int


class TracemallocStats(BaseModel):
    """What tracemalloc has traced, present only while it is tracing."""

    current_bytes: int
    peak_bytes: int
    baseline_taken: bool
    top_allocations: list[AllocationStat]
    top_files: list[AllocationStat]
    top_growth: list[AllocationGrowth]


class HeapTrim(BaseModel):
    """The effect of asking glibc to return free heap to the kernel."""

    rss_before_bytes: int | None
    rss_after_bytes: int | None
    released: bool


class MemoryDiagnostics(BaseModel):
    """One reading of this process's memory; a field is null where the platform lacks it."""

    rss_bytes: int | None
    peak_rss_bytes: int | None
    mallinfo: MallinfoStats | None
    allocated_blocks: int
    gc_count: tuple[int, int, int]
    top_types: list[TypeCount]
    tracemalloc: TracemallocStats | None
    tracemalloc_hint: str | None
    trim: HeapTrim | None
