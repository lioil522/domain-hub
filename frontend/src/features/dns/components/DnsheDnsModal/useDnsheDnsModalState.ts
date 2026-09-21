import { useState } from "react";
import type { DnsRecord } from "../../../../types/dns";

export function useDnsheDnsModalState() {
  const [newDnsType, setNewDnsType] = useState("A");
  const [newDnsName, setNewDnsName] = useState("");
  const [newDnsContent, setNewDnsContent] = useState("");
  const [newDnsTtl, setNewDnsTtl] = useState(600);
  const [newDnsPriority, setNewDnsPriority] = useState<number>(10);
  const [newDnsLine, setNewDnsLine] = useState("");
  const [dnsFormOpen, setDnsFormOpen] = useState(false);

  const [editingDnsKey, setEditingDnsKey] = useState<string | null>(null);
  const [editDnsType, setEditDnsType] = useState("A");
  const [editDnsName, setEditDnsName] = useState("");
  const [editDnsContent, setEditDnsContent] = useState("");
  const [editDnsTtl, setEditDnsTtl] = useState(600);
  const [editDnsPriority, setEditDnsPriority] = useState<number>(10);
  const [editDnsLine, setEditDnsLine] = useState("");

  const [dnsBatchOpen, setDnsBatchOpen] = useState(false);
  const [dnsBatchInput, setDnsBatchInput] = useState("");
  const [dnsBatchType, setDnsBatchType] = useState("A");
  const [dnsBatchName, setDnsBatchName] = useState("@");
  const [dnsBatchTtl, setDnsBatchTtl] = useState(600);
  const [dnsBatchPriority, setDnsBatchPriority] = useState<number>(10);
  const [dnsBatchLine, setDnsBatchLine] = useState("");
  const [dnsBatchResults, setDnsBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  const [selectedDnsKeys, setSelectedDnsKeys] = useState<Set<string>>(new Set());

  const [dnsEditPanelOpen, setDnsEditPanelOpen] = useState(false);
  const [dnsEditFields, setDnsEditFields] = useState({
    type: false,
    name: false,
    content: false,
    ttl: true,
    line: false,
    priority: false,
    proxied: false,
  });
  const [batchEditType, setBatchEditType] = useState("A");
  const [batchEditName, setBatchEditName] = useState("@");
  const [batchEditTtl, setBatchEditTtl] = useState(600);
  const [batchEditLine, setBatchEditLine] = useState("");
  const [batchEditPriority, setBatchEditPriority] = useState<number>(10);
  const [batchEditContents, setBatchEditContents] = useState<Record<string, string>>({});
  const [dnsEditResults, setDnsEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [loadingDns, setLoadingDns] = useState(false);

  return {
    newDnsType, setNewDnsType, newDnsName, setNewDnsName, newDnsContent, setNewDnsContent,
    newDnsTtl, setNewDnsTtl, newDnsPriority, setNewDnsPriority, newDnsLine, setNewDnsLine,
    dnsFormOpen, setDnsFormOpen,
    editingDnsKey, setEditingDnsKey, editDnsType, setEditDnsType, editDnsName, setEditDnsName,
    editDnsContent, setEditDnsContent, editDnsTtl, setEditDnsTtl, editDnsPriority, setEditDnsPriority,
    editDnsLine, setEditDnsLine,
    dnsBatchOpen, setDnsBatchOpen, dnsBatchInput, setDnsBatchInput, dnsBatchType, setDnsBatchType,
    dnsBatchName, setDnsBatchName, dnsBatchTtl, setDnsBatchTtl, dnsBatchPriority, setDnsBatchPriority,
    dnsBatchLine, setDnsBatchLine, dnsBatchResults, setDnsBatchResults,
    selectedDnsKeys, setSelectedDnsKeys,
    dnsEditPanelOpen, setDnsEditPanelOpen, dnsEditFields, setDnsEditFields,
    batchEditType, setBatchEditType, batchEditName, setBatchEditName, batchEditTtl, setBatchEditTtl,
    batchEditLine, setBatchEditLine, batchEditPriority, setBatchEditPriority,
    batchEditContents, setBatchEditContents, dnsEditResults, setDnsEditResults,
    dnsRecords, setDnsRecords, loadingDns, setLoadingDns,
  };
}
