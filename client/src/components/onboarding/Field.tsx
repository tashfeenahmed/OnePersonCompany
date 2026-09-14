import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useId,
  type ReactNode,
} from "react";
import { CircleAlert } from "lucide-react";

function flattenFields(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((node) =>
    isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
      ? flattenFields(node.props.children)
      : [node],
  );
}

/** Keep the error beside its label and associate it with the actual control. */
export function Field({
  label,
  error,
  clearError,
  children,
}: {
  label: string;
  error?: string;
  clearError?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const fields = flattenFields(children);
  const firstControl = fields.findIndex(
    (node) =>
      isValidElement(node) &&
      ["input", "textarea", "select"].includes(String(node.type)),
  );
  const controls = Children.map(fields, (node, index) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        id?: string;
        "aria-describedby"?: string;
        "aria-invalid"?: boolean;
      }>(node)
    )
      return node;
    if (!["input", "textarea", "select"].includes(String(node.type)))
      return node;
    return cloneElement(node, {
      id: index === firstControl ? id : node.props.id,
      "aria-invalid": error ? true : undefined,
      "aria-describedby":
        [node.props["aria-describedby"], error ? errorId : null]
          .filter(Boolean)
          .join(" ") || undefined,
    });
  });
  return (
    <div className="ob-field" onChangeCapture={clearError}>
      <div className="ob-field-heading">
        <label htmlFor={id}>{label}</label>
        {error && (
          <span className="ob-field-error" role="alert" id={errorId}>
            <CircleAlert size={12} aria-hidden="true" />
            {error}
          </span>
        )}
      </div>
      {controls}
    </div>
  );
}
