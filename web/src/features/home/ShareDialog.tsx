import { useEffect, useState } from "react"
import { FiShare } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Dialog, DialogSection } from "@/design-system/feedback/Dialog"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  canCopyImages,
  copyImage,
  downloadBlob,
  renderCard,
  type ShareCard,
  shareFilename,
} from "@/features/home/shareImage"

/**
 * Home's figures and usage chart as an image to download or copy. The image is
 * painted in the browser from what the page already shows; nothing about it
 * leaves the page unless the reader saves or pastes it somewhere.
 */
export function ShareDialog({
  card,
  startIso,
  endIso,
  isReady,
}: {
  card: ShareCard
  startIso: string
  endIso: string
  /** The page's figures have arrived, so there is something to share. */
  isReady: boolean
}) {
  const [isOpen, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        onPress={() => setOpen(true)}
        isDisabled={!isReady}
        aria-label="Share as an image"
      >
        <FiShare aria-hidden className="size-3.5" />
        <span className="max-sm:sr-only">Share</span>
      </Button>
      {isOpen ? (
        <ShareDialogBody
          card={card}
          filename={shareFilename(startIso, endIso)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function ShareDialogBody({
  card,
  filename,
  onClose,
}: {
  card: ShareCard
  filename: string
  onClose: () => void
}) {
  const [image, setImage] = useState<{ blob: Blob; url: string }>()
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState("")
  // The card is what the page showed when the dialog opened: painted once, so
  // a background refetch does not repaint the preview under the reader.
  const [frozen] = useState(card)

  useEffect(() => {
    let isCancelled = false
    let url = ""
    renderCard(frozen)
      .then((blob) => {
        if (isCancelled) return
        url = URL.createObjectURL(blob)
        setImage({ blob, url })
      })
      .catch((cause: unknown) => {
        if (!isCancelled) setError(cause)
      })
    return () => {
      isCancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [frozen])

  const canCopy = canCopyImages()
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="Share as an image"
      description="Made in your browser from the figures on this page. Nothing is uploaded."
      size="lg"
      status={
        notice ? (
          <p role="status" className="text-caption">
            {notice}
          </p>
        ) : undefined
      }
      actions={
        <>
          <Button onPress={onClose}>Close</Button>
          {canCopy ? (
            <Button
              isDisabled={!image}
              onPress={() => {
                if (!image) return
                void copyImage(image.blob).then((isCopied) =>
                  setNotice(
                    isCopied
                      ? "Copied to the clipboard."
                      : "The browser did not allow the copy. Download it instead.",
                  ),
                )
              }}
            >
              Copy image
            </Button>
          ) : null}
          <Button
            variant="primary"
            isDisabled={!image}
            onPress={() => {
              if (!image) return
              downloadBlob(image.blob, filename)
              setNotice(`Saved as ${filename}.`)
            }}
          >
            Download PNG
          </Button>
        </>
      }
    >
      <DialogSection>
        {error ? (
          <ErrorBanner error={error} />
        ) : image ? (
          <img
            src={image.url}
            alt={`${frozen.title}: ${frozen.figures
              .map((figure) => `${figure.label} ${figure.value}`)
              .join(", ")}`}
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            className="h-auto w-full border border-border"
          />
        ) : (
          <Skeleton className="aspect-[16/9] w-full" ariaLabel="Drawing" />
        )}
      </DialogSection>
    </Dialog>
  )
}
