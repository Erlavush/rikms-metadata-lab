"use client";

import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type MarkdownValueProps = {
  value: string;
};

const sanitizedMarkdownSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "u"],
};

function SafeLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  return <a {...props} href={href} rel="noreferrer noopener" target="_blank">{children}</a>;
}

function OmittedImage({ alt }: ComponentPropsWithoutRef<"img">) {
  return <span className="markdown-image-placeholder">{alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}</span>;
}

export function MarkdownValue({ value }: MarkdownValueProps) {
  return (
    <div className="field-value">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizedMarkdownSchema]]}
        components={{ a: SafeLink, img: OmittedImage }}
      >
        {value}
      </Markdown>
    </div>
  );
}
