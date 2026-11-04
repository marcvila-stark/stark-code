import { mediaKindFromPath } from "@starkfuture/shared/filePreview";
import { Children, createContext, isValidElement, useMemo, useState, type ReactNode } from "react";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { InlinePreviewStage } from "./InlinePreviewStage";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

type ImageBlockNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: ImageBlockNode[];
};

function imageInBlock(node: ImageBlockNode): ImageBlockNode | undefined {
  if (node.type !== "element" || node.tagName !== "p") return;
  const children = node.children?.filter(
    (child) => child.type !== "text" || child.value?.trim() !== "",
  );
  if (children?.length !== 1) return;
  const image = children[0];
  if (image?.type !== "element" || image.tagName !== "img") return;
  const source = image.properties?.dataLocalSrc ?? image.properties?.src;
  // Authored dimensions usually indicate a badge or an inline illustration.
  // Links, captions and mixed prose keep their original document structure.
  if (
    typeof source !== "string" ||
    mediaKindFromPath(source) === "video" ||
    image.properties?.width !== undefined ||
    image.properties?.height !== undefined
  )
    return;
  return image;
}

function splitImageOnlyParagraph(node: ImageBlockNode): ImageBlockNode[] {
  if (
    node.type !== "element" ||
    node.tagName !== "p" ||
    Object.keys(node.properties ?? {}).length > 0
  )
    return [node];
  const children = node.children?.filter(
    (child) => (child.type !== "text" || child.value?.trim() !== "") && child.tagName !== "br",
  );
  if (!children || children.length < 2) return [node];
  const blocks = children.map((child) => ({
    type: "element",
    tagName: "p",
    properties: {},
    children: [child],
  }));
  return blocks.every((block) => imageInBlock(block)) ? blocks : [node];
}

/** Group only neighboring top-level figures, never across a caption or a paragraph. */
export function rehypeMarkdownPreviewGalleries() {
  return (tree: ImageBlockNode) => {
    if (tree.type !== "root" || !tree.children) return;
    const result: ImageBlockNode[] = [];
    const nodes = tree.children.flatMap(splitImageOnlyParagraph);
    for (let index = 0; index < nodes.length; index += 1) {
      const first = nodes[index]!;
      if (!imageInBlock(first)) {
        result.push(first);
        continue;
      }
      const images = [first];
      let end = index;
      while (end + 1 < nodes.length) {
        let next = end + 1;
        while (nodes[next]?.type === "text" && nodes[next]?.value?.trim() === "") next += 1;
        const candidate = nodes[next];
        if (!candidate || !imageInBlock(candidate)) break;
        images.push(candidate);
        end = next;
      }
      for (const block of images) {
        const image = imageInBlock(block)!;
        image.properties = { ...image.properties, dataStandalone: true };
      }
      result.push({
        type: "element",
        tagName: "div",
        properties: { dataPreviewGallery: true },
        children: images,
      });
      index = end;
    }
    tree.children = result;
  };
}

export function markdownPreviewTitles(node: ImageBlockNode): string[] | undefined {
  if (node.properties?.dataPreviewGallery !== true) return;
  return node.children?.map((block) => {
    const alt = imageInBlock(block)?.properties?.alt;
    return typeof alt === "string" && alt.trim() ? alt.trim() : "Image";
  });
}

export const MarkdownPreviewImageContext = createContext<
  ((image: HTMLImageElement | null) => void) | null
>(null);

export function MarkdownPreviewGallery(props: {
  readonly children: ReactNode;
  readonly titles: readonly string[];
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const slides = Children.toArray(props.children);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, slides.length - 1));
  const [images, setImages] = useState<ReadonlyArray<HTMLImageElement | null>>([]);
  const registrations = useMemo(
    () =>
      Array.from(
        { length: slides.length },
        (_, slideIndex) => (image: HTMLImageElement | null) =>
          setImages((current) => {
            if (current[slideIndex] === image) return current;
            const next = [...current];
            next[slideIndex] = image;
            return next;
          }),
      ),
    [slides.length],
  );
  const selectedImage = images[index];
  return (
    <InlinePreviewStage
      title={props.titles[index] ?? "Image"}
      index={index}
      count={slides.length}
      onPrevious={() => setSelected((index + slides.length - 1) % slides.length)}
      onNext={() => setSelected((index + 1) % slides.length)}
      expandDisabled={!selectedImage}
      onExpand={() => {
        const item = selectedImage ? markdownImageItems.get(selectedImage) : undefined;
        if (selectedImage && item) props.onImageExpand(markdownImageGallery(selectedImage, item));
      }}
    >
      {slides.map((slide, slideIndex) => (
        <div
          key={isValidElement(slide) ? slide.key : props.titles[slideIndex]}
          hidden={slideIndex !== index}
          className="[&>p]:my-0 [&>p]:grid [&>p]:w-full [&>p]:max-w-none [&>p]:place-items-center [&_img]:max-h-[32rem] [&_img]:max-w-full"
        >
          <MarkdownPreviewImageContext value={registrations[slideIndex] ?? null}>
            {slide}
          </MarkdownPreviewImageContext>
        </div>
      ))}
    </InlinePreviewStage>
  );
}
